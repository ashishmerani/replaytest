/**
 * Sampled traffic register — exact-evidence observations over a bounded,
 * newest-first session sample. This is intentionally separate from the core
 * gap map: it describes what the sampled traffic contained; it never makes
 * coverage or test-behaviour claims.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { emitArtifact } from './artifact-registry.js';
import { findWitnessedLogin } from './auth-witness.js';
import { segmentJourneys } from './journeys.js';
import { formatLocalTime } from './local-time.js';
import { displayOrigin, type AppScope } from './app-scope.js';
import type { NeutralException, NeutralSession, NeutralViewport } from './neutral-session.js';

export const SAMPLED_REGISTER_SCHEMA_VERSION = 1;
export const SAMPLED_REGISTER_REFRESH_COMMAND = 'replaytest gaps --refresh-sample';
export const SAMPLED_REGISTER_RELATIVE_PATH = path.join('.replaytest', 'cache', 'sampled-register.json');

const EXAMPLE_LIMIT = 3;

export type SampledAssessmentKind = 'present' | 'absent' | 'not-assessable';

/** Three-valued exact-evidence classifier result, never a coverage state. */
export interface SampledAssessment<T = undefined> {
  kind: SampledAssessmentKind;
  value?: T;
  reason?: string;
}

/** The minimum replay/CLI-inspection identity retained in every example. */
export interface SampledSessionReference {
  sessionId: string;
  distinctId: string;
  /** The newest-N query's last event timestamp for this session. */
  timestamp: string;
}

export interface SampledSessionEvidence {
  reference: SampledSessionReference;
  session: NeutralSession;
}

/** What the boundary did to one sample run, handed in by whoever applied it. */
export interface SampledScopeOutcome {
  scope: AppScope;
  /** Returned sessions that belonged to another app. */
  excludedN: number;
  /** Returned sessions with no page URL to attribute. */
  unattributableN: number;
  /** Present on every scoped refresh: it records the bounded project-wide candidate search. */
  search?: {
    /** Actual provider-returned candidate bound for this saved run. */
    candidateLimit: number;
    candidateCeiling: number;
    candidatesChecked: number;
    timeBudgetMs: number;
    stoppedBy: 'target-met' | 'time-budget' | 'candidate-ceiling' | 'provider-returned-fewer';
  };
}

/** The app boundary a sample was taken inside, as persisted with it. */
export interface SampledRegisterScope {
  app: string;
  prefixes: readonly string[];
}

export interface SampledRegisterContract {
  populationOrder:
    | 'your N most recent sessions, ordered by last event timestamp, newest first'
    | 'newest project sessions checked first; kept sessions match your app scope';
  requestedN: number;
  /**
   * How many sessions the sample RETURNED from the provider — the pre-scope
   * figure. A scoped candidate search can legitimately exceed `requestedN`; its
   * `scopeSearch` block says how many project sessions were checked.
   */
  returnedN: number;
  /** `null` means the sample run returned no usable exact sessions. */
  timeInterval: { oldest: string; newest: string } | null;
  identityDedupRule: 'unique session_id; one row per session';
  /** Partial never masquerades as a complete requested sample. */
  degradation: 'complete' | 'partial';
  /**
   * The app boundary this sample was taken inside. ABSENT means unscoped —
   * including for registers written by builds that predate scoping, where
   * "no declared boundary" is exactly what happened, so the older artifact
   * needs no version bump to stay honest.
   */
  scope?: SampledRegisterScope;
  /**
   * Returned sessions the boundary dropped as belonging to another app.
   * Present on every scoped run, `0` included: "the scope ran and kept
   * everything" is a different statement from "no scope ran".
   */
  scopeExcludedN?: number;
  /**
   * Returned sessions the boundary dropped because they carried no page URL to
   * attribute. Present only on a scoped run, and only when non-zero — the same
   * shape `AppScopeDisclosure` uses, so the two never disagree.
   */
  scopeUnattributableN?: number;
  /** Bound and stop reason for a scoped candidate search; absent for the normal newest-N path. */
  scopeSearch?: NonNullable<SampledScopeOutcome['search']>;
}

interface ObservationBase {
  /**
   * The number of sessions this register DESCRIBES, never all traffic — the
   * returned exact sessions, minus any the declared app scope dropped. It
   * equals `contract.returnedN` on every unscoped run.
   */
  sampleDenominator: number;
  assessedSessions: number;
  absentSessions: number;
  notAssessableSessions: number;
  source: 'exact session evidence in the sampled register';
}

export interface ViewportBucketObservation {
  width: number;
  height: number;
  sessionCount: number;
  examples: SampledSessionReference[];
}

export interface LoginObservation {
  loginPath: string;
  sessionCount: number;
  examples: SampledSessionReference[];
}

export interface ConsoleErrorObservation {
  sessionCount: number;
  examples: SampledSessionReference[];
}

export interface ExceptionTypeObservation {
  type: string;
  sessionCount: number;
  examples: SampledSessionReference[];
}

export interface SampledTrafficObservationLists {
  viewports: ObservationBase & { buckets: ViewportBucketObservation[] };
  witnessedLogins: ObservationBase & { logins: LoginObservation[] };
  consoleErrors: ObservationBase & {
    sessionsWithErrors: ConsoleErrorObservation[];
    notice: 'error-to-test generation is not available in v1';
  };
  exceptions: ObservationBase & {
    types: ExceptionTypeObservation[];
    notice: 'error-to-test generation is not available in v1';
  };
}

/** The customer-visible, provider-neutral projection stored in the artifact. */
export interface SampledTrafficObservations {
  sampledAt: string;
  contract: SampledRegisterContract;
  observations: SampledTrafficObservationLists;
}

export interface SampledRegisterEnvelope {
  schemaVersion: typeof SAMPLED_REGISTER_SCHEMA_VERSION;
  identity: { projectFingerprint: string };
  sampledAt: string;
  contract: SampledRegisterContract;
  observations: SampledTrafficObservationLists;
}

function present<T>(value: T): SampledAssessment<T> {
  return { kind: 'present', value };
}

function absent<T = never>(): SampledAssessment<T> {
  return { kind: 'absent' };
}

function notAssessable<T = never>(reason: string): SampledAssessment<T> {
  return { kind: 'not-assessable', reason };
}

function validViewport(viewport: NeutralViewport | undefined): viewport is NeutralViewport {
  return viewport !== undefined && Number.isInteger(viewport.width) && viewport.width > 0 &&
    Number.isInteger(viewport.height) && viewport.height > 0;
}

/** A missing viewport was not captured; it is not evidence of an absent screen. */
export function classifySampledViewport(session: NeutralSession): SampledAssessment<NeutralViewport> {
  return validViewport(session.viewport)
    ? present(session.viewport)
    : notAssessable('Viewport dimensions were not captured for this exact session.');
}

/** A usable exact journey can either witness the narrow login shape or not. */
export function classifySampledLogin(session: NeutralSession): SampledAssessment<{ loginPath: string }> {
  const journeys = segmentJourneys(session);
  if (journeys.length === 0) {
    return notAssessable('This exact session had no segmentable journey evidence.');
  }
  const witnessed = findWitnessedLogin(journeys);
  return witnessed === undefined ? absent() : present({ loginPath: witnessed.loginPath });
}

/**
 * `undefined` means the console lookup was not run; `null` preserves the
 * fetched-no-recording floor. Neither can honestly become "no errors".
 */
export function classifySampledConsoleErrors(session: NeutralSession): SampledAssessment {
  if (session.witnessedConsole === undefined) {
    return notAssessable('Console-truth was not fetched for this exact session.');
  }
  if (session.witnessedConsole === null) {
    return notAssessable('No recording supplied console-truth for this exact session.');
  }
  return session.witnessedConsole.errorCount > 0 ? present(undefined) : absent();
}

/** `undefined` means exception evidence was not fetched; an empty array is an assessed absence. */
export function classifySampledExceptions(session: NeutralSession): SampledAssessment<NeutralException[]> {
  if (session.witnessedExceptions === undefined) {
    return notAssessable('Exception evidence was not fetched for this exact session.');
  }
  return session.witnessedExceptions.length > 0 ? present(session.witnessedExceptions) : absent();
}

function emptyBase(sampleDenominator: number): ObservationBase {
  return {
    sampleDenominator,
    assessedSessions: 0,
    absentSessions: 0,
    notAssessableSessions: 0,
    source: 'exact session evidence in the sampled register',
  };
}

function countAssessment<T>(base: ObservationBase, assessment: SampledAssessment<T>): void {
  if (assessment.kind === 'not-assessable') {
    base.notAssessableSessions += 1;
    return;
  }
  base.assessedSessions += 1;
  if (assessment.kind === 'absent') base.absentSessions += 1;
}

function addExample(examples: SampledSessionReference[], reference: SampledSessionReference): void {
  if (examples.length < EXAMPLE_LIMIT) examples.push(reference);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function sampleTimeInterval(evidence: readonly SampledSessionEvidence[]): SampledRegisterContract['timeInterval'] {
  if (evidence.length === 0) return null;
  const timestamps = evidence.map(({ reference }) => reference.timestamp);
  return {
    oldest: [...timestamps].sort((a, b) => Date.parse(a) - Date.parse(b) || compareText(a, b))[0],
    newest: [...timestamps].sort((a, b) => Date.parse(b) - Date.parse(a) || compareText(b, a))[0],
  };
}

/**
 * The contract block for one sample run.
 *
 * Scope-dropped sessions still COUNT as returned: the provider gave them to
 * us, we chose not to describe them. Folding them back into `returnedN` is
 * what stops a deliberate boundary from re-reading as a degraded sample —
 * `degradation` keeps answering only "did we get the N we asked for?".
 */
function buildSampledContract(
  requestedN: number,
  described: readonly SampledSessionEvidence[],
  scope: SampledScopeOutcome | undefined,
): SampledRegisterContract {
  const droppedByScope = scope === undefined ? 0 : scope.excludedN + scope.unattributableN;
  const returnedN = described.length + droppedByScope;
  return {
    populationOrder: scope?.search === undefined
      ? 'your N most recent sessions, ordered by last event timestamp, newest first'
      : 'newest project sessions checked first; kept sessions match your app scope',
    requestedN,
    returnedN,
    timeInterval: sampleTimeInterval(described),
    identityDedupRule: 'unique session_id; one row per session',
    degradation: scope?.search === undefined
      ? returnedN < requestedN ? 'partial' : 'complete'
      : described.length < requestedN ? 'partial' : 'complete',
    ...(scope === undefined ? {} : {
      scope: { app: scope.scope.app, prefixes: [...scope.scope.prefixes] },
      scopeExcludedN: scope.excludedN,
      ...(scope.unattributableN === 0 ? {} : { scopeUnattributableN: scope.unattributableN }),
      ...(scope.search === undefined ? {} : { scopeSearch: scope.search }),
    }),
  };
}

/**
 * Purely derives a descriptive sampled register. Duplicate ids are discarded
 * defensively at this boundary so the contract remains true even for a
 * hand-built fixture or a malformed upstream response.
 */
export function deriveSampledTrafficObservations(input: {
  requestedN: number;
  sampledAt: string;
  /** IN-SCOPE evidence only; the caller applies the boundary at the fetch chokepoint. */
  sessions: readonly SampledSessionEvidence[];
  /** Omit entirely for an unscoped run — its absence is what keeps that output byte-identical. */
  scope?: SampledScopeOutcome;
}): SampledTrafficObservations {
  const bySessionId = new Map<string, SampledSessionEvidence>();
  for (const item of input.sessions) {
    // Input follows the newest-first query order, so first occurrence is the
    // contract-preserving representative if a malformed duplicate arrives.
    if (!bySessionId.has(item.reference.sessionId)) bySessionId.set(item.reference.sessionId, item);
  }
  const unique = [...bySessionId.values()];
  const denominator = unique.length;
  const viewportBase = emptyBase(denominator);
  const loginBase = emptyBase(denominator);
  const consoleBase = emptyBase(denominator);
  const exceptionBase = emptyBase(denominator);
  const viewports = new Map<string, ViewportBucketObservation>();
  const logins = new Map<string, LoginObservation>();
  const consoleExamples: SampledSessionReference[] = [];
  // True present-count; `consoleExamples` is display-capped at EXAMPLE_LIMIT and must never be the count source.
  let consolePresentCount = 0;
  const exceptionTypes = new Map<string, ExceptionTypeObservation>();

  for (const item of unique) {
    const viewport = classifySampledViewport(item.session);
    countAssessment(viewportBase, viewport);
    if (viewport.kind === 'present' && viewport.value !== undefined) {
      const key = `${viewport.value.width}x${viewport.value.height}`;
      const bucket = viewports.get(key) ?? {
        width: viewport.value.width,
        height: viewport.value.height,
        sessionCount: 0,
        examples: [],
      };
      bucket.sessionCount += 1;
      addExample(bucket.examples, item.reference);
      viewports.set(key, bucket);
    }

    const login = classifySampledLogin(item.session);
    countAssessment(loginBase, login);
    if (login.kind === 'present' && login.value !== undefined) {
      const observation = logins.get(login.value.loginPath) ?? {
        loginPath: login.value.loginPath,
        sessionCount: 0,
        examples: [],
      };
      observation.sessionCount += 1;
      addExample(observation.examples, item.reference);
      logins.set(login.value.loginPath, observation);
    }

    const consoleErrors = classifySampledConsoleErrors(item.session);
    countAssessment(consoleBase, consoleErrors);
    if (consoleErrors.kind === 'present') {
      consolePresentCount += 1;
      addExample(consoleExamples, item.reference);
    }

    const exceptions = classifySampledExceptions(item.session);
    countAssessment(exceptionBase, exceptions);
    if (exceptions.kind === 'present' && exceptions.value !== undefined) {
      for (const type of new Set(exceptions.value.map((exception) => exception.type).filter(Boolean))) {
        const observation = exceptionTypes.get(type) ?? { type, sessionCount: 0, examples: [] };
        observation.sessionCount += 1;
        addExample(observation.examples, item.reference);
        exceptionTypes.set(type, observation);
      }
    }
  }

  return {
    sampledAt: input.sampledAt,
    contract: buildSampledContract(input.requestedN, unique, input.scope),
    observations: {
      viewports: {
        ...viewportBase,
        buckets: [...viewports.values()].sort((a, b) => b.sessionCount - a.sessionCount || a.width - b.width || a.height - b.height),
      },
      witnessedLogins: {
        ...loginBase,
        logins: [...logins.values()].sort((a, b) => b.sessionCount - a.sessionCount || compareText(a.loginPath, b.loginPath)),
      },
      consoleErrors: {
        ...consoleBase,
        sessionsWithErrors: consolePresentCount === 0 ? [] : [{ sessionCount: consolePresentCount, examples: consoleExamples }],
        notice: 'error-to-test generation is not available in v1',
      },
      exceptions: {
        ...exceptionBase,
        types: [...exceptionTypes.values()].sort((a, b) => b.sessionCount - a.sessionCount || compareText(a.type, b.type)),
        notice: 'error-to-test generation is not available in v1',
      },
    },
  };
}

export function sampledRegisterPath(rootDir: string = process.cwd()): string {
  return path.join(rootDir, SAMPLED_REGISTER_RELATIVE_PATH);
}

function toEnvelope(projectFingerprint: string, observations: SampledTrafficObservations): SampledRegisterEnvelope {
  return {
    schemaVersion: SAMPLED_REGISTER_SCHEMA_VERSION,
    identity: { projectFingerprint },
    sampledAt: observations.sampledAt,
    contract: observations.contract,
    observations: observations.observations,
  };
}

/** Atomic, registered artifact write. The final rename cannot expose a partial JSON file. */
export function writeSampledRegister(
  projectFingerprint: string,
  observations: SampledTrafficObservations,
  targetPath: string = sampledRegisterPath(),
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  emitArtifact('sampled-register-cache', temporaryPath, `${JSON.stringify(toEnvelope(projectFingerprint, observations), null, 2)}\n`);
  fs.renameSync(temporaryPath, targetPath);
}

/**
 * The scope block is validated as a UNIT: a register that carries a boundary
 * must carry its drop count too, because rendering the boundary without the
 * count would claim a filter ran and say nothing about what it removed.
 */
function isScopeBlock(record: Record<string, unknown>): boolean {
  const scope = record.scope;
  if (scope === undefined) {
    return record.scopeExcludedN === undefined && record.scopeUnattributableN === undefined;
  }
  if (typeof scope !== 'object' || scope === null) return false;
  const { app, prefixes } = scope as { app?: unknown; prefixes?: unknown };
  return typeof app === 'string' && app !== '' &&
    Array.isArray(prefixes) && prefixes.length > 0 && prefixes.every((prefix) => typeof prefix === 'string') &&
    Number.isInteger(record.scopeExcludedN) &&
    (record.scopeUnattributableN === undefined || Number.isInteger(record.scopeUnattributableN));
}

function isContract(value: unknown): value is SampledRegisterContract {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const interval = record.timeInterval;
  const intervalValid = interval === null || (typeof interval === 'object' && interval !== null &&
    typeof (interval as Record<string, unknown>).oldest === 'string' && typeof (interval as Record<string, unknown>).newest === 'string');
  return record.populationOrder === 'your N most recent sessions, ordered by last event timestamp, newest first' &&
    Number.isInteger(record.requestedN) && Number.isInteger(record.returnedN) && intervalValid &&
    record.identityDedupRule === 'unique session_id; one row per session' &&
    (record.degradation === 'complete' || record.degradation === 'partial') &&
    isScopeBlock(record);
}

function isObservations(value: unknown): value is SampledTrafficObservationLists {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const base = (entry: unknown): entry is ObservationBase => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return Number.isInteger(item.sampleDenominator) && Number.isInteger(item.assessedSessions) &&
      Number.isInteger(item.absentSessions) && Number.isInteger(item.notAssessableSessions) &&
      item.source === 'exact session evidence in the sampled register';
  };
  const viewports = record.viewports as Record<string, unknown> | undefined;
  const logins = record.witnessedLogins as Record<string, unknown> | undefined;
  const consoleErrors = record.consoleErrors as Record<string, unknown> | undefined;
  const exceptions = record.exceptions as Record<string, unknown> | undefined;
  return base(viewports) && Array.isArray(viewports.buckets) &&
    base(logins) && Array.isArray(logins.logins) &&
    base(consoleErrors) && Array.isArray(consoleErrors.sessionsWithErrors) &&
    consoleErrors.notice === 'error-to-test generation is not available in v1' &&
    base(exceptions) && Array.isArray(exceptions.types) &&
    exceptions.notice === 'error-to-test generation is not available in v1';
}

function isEnvelope(value: unknown): value is SampledRegisterEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  return record.schemaVersion === SAMPLED_REGISTER_SCHEMA_VERSION && typeof record.sampledAt === 'string' &&
    typeof identity === 'object' && identity !== null && typeof (identity as Record<string, unknown>).projectFingerprint === 'string' &&
    isContract(record.contract) && isObservations(record.observations);
}

/** Missing, corrupt, wrong-version, or wrong-project artifacts are all an honest not-assessed state. */
export function readSampledRegister(
  projectFingerprint: string | undefined,
  targetPath: string = sampledRegisterPath(),
): SampledTrafficObservations | undefined {
  if (projectFingerprint === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    if (!isEnvelope(parsed) || parsed.identity.projectFingerprint !== projectFingerprint) return undefined;
    return { sampledAt: parsed.sampledAt, contract: parsed.contract, observations: parsed.observations };
  } catch {
    return undefined;
  }
}

export interface SampledObservationsNotAssessed {
  state: 'not-assessed';
  message: `Take a sample now — it looks at your newest sessions without changing the map above: \`${typeof SAMPLED_REGISTER_REFRESH_COMMAND}\``;
  refreshCommand: typeof SAMPLED_REGISTER_REFRESH_COMMAND;
}

export function notAssessedSampledObservations(): SampledObservationsNotAssessed {
  return {
    state: 'not-assessed',
    message: `Take a sample now — it looks at your newest sessions without changing the map above: \`${SAMPLED_REGISTER_REFRESH_COMMAND}\``,
    refreshCommand: SAMPLED_REGISTER_REFRESH_COMMAND,
  };
}

/**
 * The saved sample exists but was taken inside a different boundary than the
 * one this run asked for. Rendering it would describe traffic the caller did
 * not ask about, and hiding it silently would look like "no sample yet" — so
 * it becomes its own state.
 */
export interface SampledObservationsScopeMismatch {
  state: 'scope-mismatch';
  /** Plain-language description of the boundary the saved sample was taken inside. */
  storedScope: string;
  /** Plain-language description of the boundary this run asked for. */
  requestedScope: string;
  message: string;
  refreshCommand: string;
}

/**
 * Scheme-stripped, de-duplicated display form for a list of app prefixes —
 * `http://host` and `https://host` collapse to one entry, matching the CLI's
 * sites-column display language. The raw prefixes stay in the stored
 * identity (see `sampledRegisterScopeKey`); only the human render strips.
 */
function dedupedDisplayPrefixes(prefixes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const prefix of prefixes) {
    const d = displayOrigin(prefix);
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

/**
 * The persisted identity of a sample's boundary. Prefixes are sorted so
 * re-ordering a declaration in the config is not mistaken for a different app,
 * matching `appScopeCacheFileSuffix` and the `sessions` stored-filter marker.
 */
export function sampledRegisterScopeKey(scope: SampledRegisterScope | undefined): string | undefined {
  return scope === undefined
    ? undefined
    : JSON.stringify({ app: scope.app, prefixes: [...scope.prefixes].sort() });
}

export function describeSampledRegisterScope(scope: SampledRegisterScope | undefined): string {
  return scope === undefined ? 'no app scope' : `${scope.app} (${dedupedDisplayPrefixes(scope.prefixes).join(', ')})`;
}

/**
 * RAW rendering of a register scope's prefixes — the scheme stays visible.
 * Used ONLY by refusal diagnostics (`sampledObservationsForScope`'s
 * mismatch `message`): a refusal whose gate compares raw keys must name the
 * RAW comparands on both sides, or a scheme-only difference prints identical
 * text and the refusal cannot show its own difference (consistent with the
 * `plan.ts` cross-origin refusal carve-out: scheme differences are real
 * origin differences). Informational display lines (`storedScope` /
 * `requestedScope`, `summarizeSampledObservations`) keep the stripped +
 * deduped `describeSampledRegisterScope` — their job is to name a boundary,
 * not to distinguish two.
 */
function describeSampledRegisterScopeRaw(scope: SampledRegisterScope | undefined): string {
  return scope === undefined ? 'no app scope' : `${scope.app} (${[...new Set(scope.prefixes)].join(', ')})`;
}

function sampledRefreshCommandFor(scope: AppScope | undefined): string {
  return scope === undefined
    ? SAMPLED_REGISTER_REFRESH_COMMAND
    : `replaytest gaps --app ${scope.app} --refresh-sample`;
}

/**
 * The read-back half of the register's scope identity: a sample taken inside
 * one boundary is never rendered under another, in either direction. A plain
 * run after a scoped refresh gets an explicit mismatch state and the command
 * that fixes it — never the scoped sample under an unscoped heading.
 */
export function sampledObservationsForScope(
  stored: SampledTrafficObservations | undefined,
  scope: AppScope | undefined,
): SampledObservationsDisplay {
  if (stored === undefined) return notAssessedSampledObservations();
  const storedScope = stored.contract.scope;
  if (sampledRegisterScopeKey(storedScope) === sampledRegisterScopeKey(scope)) return stored;
  // The informational `storedScope` / `requestedScope` fields use the stripped
  // + deduped form (their job is to NAME the boundary); the refusal `message`
  // renders the RAW prefixes so a scheme-only difference stays visible.
  const storedDescription = describeSampledRegisterScope(storedScope);
  const requestedDescription = describeSampledRegisterScope(scope);
  const storedDescriptionRaw = describeSampledRegisterScopeRaw(storedScope);
  const requestedDescriptionRaw = describeSampledRegisterScopeRaw(scope);
  const refreshCommand = sampledRefreshCommandFor(scope);
  return {
    state: 'scope-mismatch',
    storedScope: storedDescription,
    requestedScope: requestedDescription,
    message:
      `The saved spot-check was taken under ${storedDescriptionRaw}, but this run asked for ${requestedDescriptionRaw} — ` +
      `showing it would describe traffic you didn't ask about. Take a fresh one: \`${refreshCommand}\`.`,
    refreshCommand,
  };
}

export type SampledObservationsDisplay =
  | SampledTrafficObservations
  | SampledObservationsNotAssessed
  | SampledObservationsScopeMismatch;

function sampledViewportSummary(observations: SampledTrafficObservations['observations']['viewports']): string {
  const topBucket = observations.buckets.reduce<ViewportBucketObservation | undefined>(
    (top, bucket) => top === undefined || bucket.sessionCount > top.sessionCount ? bucket : top,
    undefined,
  );
  if (topBucket !== undefined) return `most screens ${topBucket.width}×${topBucket.height}`;
  return observations.assessedSessions === 0 ? "screen sizes: couldn't check" : 'no screen sizes seen';
}

function sampledLoginSummary(observations: SampledTrafficObservations['observations']['witnessedLogins']): string {
  if (observations.logins.length > 0) {
    return `${observations.logins.reduce((total, login) => total + login.sessionCount, 0)} with a login`;
  }
  return observations.assessedSessions === 0 ? "logins: couldn't check" : 'no logins seen';
}

type SampledErrorEvidence = 'present' | 'none-seen' | 'couldnt-check';

function sampledErrorEvidence(
  observations: SampledTrafficObservations['observations']['consoleErrors'] | SampledTrafficObservations['observations']['exceptions'],
  count: number,
): SampledErrorEvidence {
  if (count > 0) return 'present';
  return observations.assessedSessions === 0 ? 'couldnt-check' : 'none-seen';
}

/**
 * One compact, evidence-honest projection of the sampled-register display.
 * This is presentation-only: it neither changes the stored artifact nor
 * makes a coverage claim.
 */
export function summarizeSampledObservations(display: SampledObservationsDisplay): string {
  if ('state' in display) {
    return display.state === 'scope-mismatch'
      ? `No spot-check for ${display.requestedScope} — the saved one was taken under ${display.storedScope}.`
      : 'No spot-check sample yet — take one below.';
  }

  const { contract, observations } = display;
  const partialSuffix = contract.degradation === 'partial'
    ? ` (partial: asked ${contract.requestedN}, got ${contract.returnedN})`
    : '';
  const described = observations.viewports.sampleDenominator;
  if (described === 0) {
    return contract.scope !== undefined && contract.returnedN > 0
      ? `Spot-check found nothing inside ${contract.scope.app} — all ${contract.returnedN} of your newest sessions were outside it${partialSuffix}.`
      : `Spot-check came back empty — no recent sessions at the detailed level${partialSuffix}.`;
  }
  const scopeSuffix = contract.scope === undefined
    ? ''
    : ` (scoped to ${contract.scope.app}; ${contract.returnedN - described} of the newest left out)`;

  const consoleCount = observations.consoleErrors.sessionsWithErrors
    .reduce((total, observation) => total + observation.sessionCount, 0);
  const exceptionCount = observations.exceptions.types
    .reduce((total, exception) => total + exception.sessionCount, 0);
  const consoleEvidence = sampledErrorEvidence(observations.consoleErrors, consoleCount);
  const exceptionEvidence = sampledErrorEvidence(observations.exceptions, exceptionCount);
  let errors: string;
  if (consoleEvidence === 'none-seen' && exceptionEvidence === 'none-seen') {
    errors = 'no errors in the sessions we could check';
  } else if (consoleEvidence === 'couldnt-check' && exceptionEvidence === 'couldnt-check') {
    errors = "errors: couldn't check";
  } else {
    const parts: string[] = [];
    if (consoleEvidence === 'present') parts.push(`${consoleCount} hit console errors`);
    if (consoleEvidence === 'none-seen' && exceptionEvidence === 'couldnt-check') {
      parts.push('no console errors in the sessions we could check');
    }
    if (consoleEvidence === 'couldnt-check') parts.push("console errors: couldn't check");
    if (exceptionEvidence === 'present') parts.push(`${exceptionCount} threw JS errors`);
    if (exceptionEvidence === 'none-seen' && consoleEvidence === 'couldnt-check') {
      parts.push('no JS errors in the sessions we could check');
    }
    if (exceptionEvidence === 'couldnt-check') parts.push("JS errors: couldn't check");
    errors = parts.join('; ');
  }

  return `Spot-check of your ${described} newest: ${sampledViewportSummary(observations.viewports)} · ${sampledLoginSummary(observations.witnessedLogins)} · ${errors}${partialSuffix}${scopeSuffix}.`;
}

function exampleReplayDestinations(
  examples: readonly SampledSessionReference[],
  watchReplay: (reference: SampledSessionReference) => string,
): string[] {
  return examples.map((reference) => watchReplay(reference));
}

/** The two no-sample states: nothing taken yet, and one taken under a different boundary. */
function sampledUnavailableLines(
  display: SampledObservationsNotAssessed | SampledObservationsScopeMismatch,
): string[] {
  if (display.state === 'scope-mismatch') {
    return ['', `No sample for ${display.requestedScope}.`, display.message];
  }
  return [
    '',
    'No sample taken yet.',
    "When you take one, we'll pull your most recent sessions (newest first), count each session once, and show you exactly how many we asked for vs. got and the time span they cover. A partial sample never fabricates counts — missing evidence shows as 'couldn't check', never as zero.",
    display.message,
  ];
}

/** The requested-vs-returned/interval/dedup preamble, unchanged by scoping. */
function sampledContractLines(contract: SampledRegisterContract, sampledAt: string): string[] {
  const partial = contract.degradation === 'partial';
  return [
    '',
    `What's in this sample: your ${contract.requestedN} most recent sessions, newest first.`,
    '  Ordered by each session\'s last event timestamp. The sample is bounded — it is not all your traffic.',
    `${partial ? `We asked for ${contract.requestedN} sessions but got ${contract.returnedN} — everything below counts only the ${contract.returnedN} we actually saw.` : `We asked for ${contract.requestedN} sessions and got all ${contract.returnedN}.`}`,
    "  A partial sample never fabricates counts — missing evidence shows as 'couldn't check', never as zero.",
    contract.timeInterval === null ? "Couldn't establish a time span — the sample came back empty." : `These sessions span ${formatLocalTime(contract.timeInterval.oldest, false)} → ${formatLocalTime(contract.timeInterval.newest)}. (UTC: ${contract.timeInterval.oldest} → ${contract.timeInterval.newest})`,
    'Each session is counted once.',
    '  Deduplicated on unique session_id — one row per session.',
    `Sampled from PostHog on ${formatLocalTime(sampledAt)} (UTC: ${sampledAt}) (via \`gaps --refresh-sample\`).`,
  ];
}

/**
 * The boundary disclosure, or nothing at all on an unscoped run — which is
 * what keeps unscoped output byte-identical. Both drop reasons are named
 * separately: "belonged to another app" and "we couldn't tell" are different
 * facts, and collapsing them would let an attribution failure hide inside a
 * deliberate exclusion.
 */
function sampledScopeLines(contract: SampledRegisterContract): string[] {
  const scope = contract.scope;
  if (scope === undefined) return [];
  const lines = [
    `Scoped to ${scope.app}: ${dedupedDisplayPrefixes(scope.prefixes).join(', ')}.`,
    '  Everything below counts only the sampled sessions inside that boundary.',
  ];
  const excluded = contract.scopeExcludedN ?? 0;
  if (excluded > 0) {
    lines.push(excluded === 1
      ? '  1 of the sampled sessions belonged to another app and was left out.'
      : `  ${excluded} of the sampled sessions belonged to other apps and were left out.`);
  }
  const unattributable = contract.scopeUnattributableN;
  if (unattributable !== undefined) {
    lines.push(unattributable === 1
      ? "  1 of the sampled sessions carried no page URLs and couldn't be attributed to an app."
      : `  ${unattributable} of the sampled sessions carried no page URLs and couldn't be attributed to an app.`);
  }
  return lines;
}

function sampledShapeInfo(detail: string): string {
  const shared = "Counts are out of the sessions this sample returned — never out of all your traffic. (JSON field: `sampleDenominator`)";
  return detail ? `${detail} ${shared}` : shared;
}

const SAMPLED_ERROR_NOTICE = "Seeing errors here doesn't create a test — turning errors into failing tests isn't part of v1. Watch a replay to judge what's going on.";

/** Terminal-only renderer; replay destinations come from the provider seam. */
export function formatSampledTrafficObservations(
  display: SampledObservationsDisplay,
  watchReplay: (reference: SampledSessionReference) => string,
): string {
  const lines = [
    'A spot-check of your newest sessions',
    'This is a bounded newest-first sample, separate from the traffic map above; it never refreshes from this page.',
    "We pulled a small sample of your most recent sessions and noted practical facts — screen sizes, logins, errors. Use it to make your tests realistic and to spot trouble worth a look. Nothing here is a coverage gap, and nothing here generates a test — it's for inspection only.",
  ];
  if ('state' in display) {
    lines.push(...sampledUnavailableLines(display));
    return lines.join('\n');
  }

  const { contract, observations } = display;
  lines.push(...sampledContractLines(contract, display.sampledAt), ...sampledScopeLines(contract));
  // The sample's DESCRIBED size, not its returned size: a boundary that keeps
  // nothing still returned sessions, and saying so is the difference between
  // "you have no traffic" and "you have none in this app".
  const described = observations.viewports.sampleDenominator;
  if (described === 0) {
    lines.push(...(contract.scope !== undefined && contract.returnedN > 0
      ? [
          `Your app scope left nothing to report — all ${contract.returnedN} of the sampled sessions fell outside ${contract.scope.app}, so there's nothing below.`,
          '  Widen the boundary in .replaytest/config.json, or take a fresh sample once in-scope traffic arrives.',
        ]
      : [
          "The sample came back empty — no recent sessions were available at the detailed level, so there's nothing to report. Try again after more traffic arrives.",
          "  Only sessions from the detailed scan (JSON value: `exact`) can appear in this sample.",
        ]));
    return lines.join('\n');
  }

  lines.push('', `Screen sizes we saw (out of ${observations.viewports.sampleDenominator} sampled sessions):`, `  ${sampledShapeInfo('Knowing real screen sizes helps you run tests at the sizes your users actually use.')}`);
  if (observations.viewports.buckets.length === 0) {
    lines.push(
      observations.viewports.assessedSessions === 0
        ? "  Couldn't check — none of the sampled sessions recorded a screen size."
        : '  No screen sizes turned up in the sessions we could check.',
    );
  }
  for (const bucket of observations.viewports.buckets) {
    lines.push(`  ${bucket.width}×${bucket.height}: ${bucket.sessionCount} of ${observations.viewports.sampleDenominator} sampled sessions`);
    exampleReplayDestinations(bucket.examples, watchReplay).forEach((destination) => lines.push(`    Watch replay: ${destination}`));
  }

  lines.push('', `Sessions where we saw a login (out of ${observations.witnessedLogins.sampleDenominator} sampled sessions):`, `  ${sampledShapeInfo("'Saw' means the recording itself shows a login step — we never infer one.")}`);
  if (observations.witnessedLogins.logins.length === 0) {
    lines.push(
      observations.witnessedLogins.assessedSessions === 0
        ? "  Couldn't check — the sampled sessions didn't have journey detail we could read."
        : '  No logins seen in the sessions we could check.',
    );
  }
  for (const login of observations.witnessedLogins.logins) {
    lines.push(`  ${login.loginPath}: ${login.sessionCount} of ${observations.witnessedLogins.sampleDenominator} sampled sessions`);
    exampleReplayDestinations(login.examples, watchReplay).forEach((destination) => lines.push(`    Watch replay: ${destination}`));
  }

  lines.push('', `Sessions that hit console errors (out of ${observations.consoleErrors.sampleDenominator} sampled sessions):`, `  ${sampledShapeInfo('')}`);
  if (observations.consoleErrors.sessionsWithErrors.length === 0) {
    lines.push(
      observations.consoleErrors.assessedSessions === 0
        ? "  Couldn't check — console-error information wasn't available for these sessions."
        : '  No console errors in the sessions we could check.',
    );
  }
  for (const observation of observations.consoleErrors.sessionsWithErrors) {
    lines.push(`  ${observation.sessionCount} of ${observations.consoleErrors.sampleDenominator} sampled sessions hit console errors`);
    exampleReplayDestinations(observation.examples, watchReplay).forEach((destination) => lines.push(`    Watch replay: ${destination}`));
  }
  lines.push(`  ${SAMPLED_ERROR_NOTICE}`);

  lines.push('', `JavaScript errors thrown, by type (out of ${observations.exceptions.sampleDenominator} sampled sessions):`, `  ${sampledShapeInfo('')}`);
  if (observations.exceptions.types.length === 0) {
    lines.push(
      observations.exceptions.assessedSessions === 0
        ? "  Couldn't check — error-event information wasn't available for these sessions."
        : '  No thrown errors in the sessions we could check.',
    );
  }
  for (const exception of observations.exceptions.types) {
    lines.push(`  ${exception.type}: ${exception.sessionCount} of ${observations.exceptions.sampleDenominator} sampled sessions`);
    exampleReplayDestinations(exception.examples, watchReplay).forEach((destination) => lines.push(`    Watch replay: ${destination}`));
  }
  lines.push(`  ${SAMPLED_ERROR_NOTICE}`);
  return lines.join('\n');
}
