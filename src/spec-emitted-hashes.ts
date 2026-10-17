/**
 * Generated-spec content markers.
 *
 * This is deliberately separate from `<slug>.plan.json`: a scaffold must not
 * touch the plan sidecar. The record answers two narrow questions for an
 * agent repair loop: did this generated spec change since replaytest last
 * wrote it, and does the current substantive plan still match that generation
 * baseline? It is not a merge base and it never authorizes a tool merge.
 *
 * Entries are retained per `(slug, specPath)`, so the record is bounded by
 * suite paths rather than the production-session corpus. A retained baseline
 * can be stale if somebody recreates a spec path without `scaffold`; that can
 * never yield a confident drift verdict because only a stamped-clean spec is
 * eligible for one. There is deliberately no eviction policy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ArtifactWriter } from './atomic-writer.js';
import { buildHandFinishedConflictDisclosure, buildHandFinishedDisclosure, buildHandFinishedStaleDisclosure } from './hand-finished.js';
import { hashSpecContent } from './heal-run-hashes.js';
import { findAnchoredOccurrences, locateStepLineByIndex } from './selector-apply.js';
import type { Sidecar } from './sidecar.js';
import { parseSidecarJson } from './triage.js';

export const SPEC_EMITTED_HASHES_SCHEMA = 'replaytest-spec-emitted-hashes/v1';
export const PLAN_HASH_DOMAIN = 'sidecar-minus-source/v1';
export const PLAN_DRIFT_KEYING = 'content-hash/v1';

export interface SpecEmittedHashEntry {
  slug: string;
  /** Workspace-relative generated-spec path; never a machine-local absolute path. */
  specPath: string;
  specSha256: string;
  /** The last time replaytest itself wrote this spec. */
  generatedAt: string;
  /** Acceptance observes this marker without changing its baseline hash. */
  acceptedAt?: string;
  /** Substantive plan hash at the time replaytest last wrote this spec. */
  planSha256?: string;
  /** The semantics of `planSha256`; unknown values are deliberately not trusted. */
  planHashDomain?: string;
  /** Substantive plan hash observed when an existing baseline was accepted. */
  acceptedPlanSha256?: string;
  /** Scoped, per-locator confirmation; never a whole-file authorship baseline. */
  confirmedFixes?: ConfirmedFix[];
}

export interface ConfirmedFix {
  /** The fresh locator expression, without the `page.` prefix. */
  anchor: string;
  /** Original sidecar step index; offsets are only a relocation hint. */
  stepIndex?: number;
  /** Byte offset at confirmation time; never used as the identity key. */
  offset: number;
  /** SHA-256 of the complete action line containing the fresh locator. */
  lineHash: string;
  confirmedAt: string;
}

export interface ConfirmedFixCheck {
  status: 'current' | 'stale';
  staleCount: number;
  reason?: string;
}

export interface SpecEmittedHashes {
  schema: typeof SPEC_EMITTED_HASHES_SCHEMA;
  algorithm: 'sha256';
  entries: SpecEmittedHashEntry[];
}

export type SpecHandEditStatus = 'stamped-clean' | 'hand-edited' | 'unknown';

export interface SpecHandEditCheck {
  status: SpecHandEditStatus;
  entry?: SpecEmittedHashEntry;
  /** Read-time result for the optional scoped fact; absent when no fact exists. */
  confirmedFixes?: ConfirmedFixCheck;
}

export type PlanDriftVerdict = 'unknown' | 'current' | 'drifted' | 'accepted-unverified' | 'unverified';

/** A mapped generated spec whose path is not the canonical slug path. */
export interface RelocatedSpecDisclosure {
  /** Workspace-relative path of the spec that the caller actually resolved. */
  specPath: string;
  /** Generation drift was deliberately not assessed for this path. */
  driftAssessed: false;
}

/** Content-addressed plan/spec drift state, safe to expose in `--json`. */
export interface PlanDriftState {
  verdict: PlanDriftVerdict;
  keying: typeof PLAN_DRIFT_KEYING;
  /**
   * The spec-axis evidence behind an actionable drift verdict/copy row. This
   * is ALWAYS the real `checkSpecHandEdits`-equivalent evaluation, including
   * on `unknown`-verdict rows (a record from before plan baselines still carries a spec
   * baseline, so the axis is evaluable even with no plan hash). It is
   * structurally ABSENT — never a fabricated `'unknown'` — when the axis was
   * genuinely not evaluated because the live plan could not be read at all.
   */
  handEditStatus?: SpecHandEditStatus;
  /** Set only by the resolver when the committed registry declares this live spec. */
  handFinishedDeclared?: true;
  /** A declared plan remains but its generated spec file is absent. */
  handFinishedStale?: true;
  /** Present only when a caller resolved this slug to a non-default spec path. */
  relocatedSpec?: RelocatedSpecDisclosure;
  /** A live plan was readable and valid enough for drift copy to be meaningful. */
  planIsReadable: boolean;
}

export interface ComputePlanDriftStateInput {
  baselinePlanSha256?: string;
  currentPlanSha256?: string;
  acceptedPlanSha256?: string;
  handEditStatus: SpecHandEditStatus;
}

/**
 * Pure join of the substantive-plan and hand-edit axes. This deliberately
 * never treats acceptance as proof that a spec was regenerated from a plan.
 *
 * The caller's `handEditStatus` is honored on EVERY row: a row whose plan axis
 * is unresolvable still knows whether the spec is stamped-clean. Readability
 * is derived from the one input that carries it — an absent
 * `currentPlanSha256` is the seventh matrix input state (the live plan could not
 * be hashed), while an absent baseline is row 1 with a perfectly readable
 * plan.
 */
export function computePlanDriftState(input: ComputePlanDriftStateInput): PlanDriftState {
  const planIsReadable = input.currentPlanSha256 !== undefined;
  if (input.baselinePlanSha256 === undefined || input.currentPlanSha256 === undefined) {
    return planDriftState('unknown', input.handEditStatus, planIsReadable);
  }
  if (input.baselinePlanSha256 === input.currentPlanSha256) {
    return planDriftState('current', input.handEditStatus);
  }
  if (input.handEditStatus === 'stamped-clean') {
    return planDriftState('drifted', input.handEditStatus);
  }
  if (input.handEditStatus === 'hand-edited' && input.acceptedPlanSha256 === input.currentPlanSha256) {
    return planDriftState('accepted-unverified', input.handEditStatus);
  }
  return planDriftState('unverified', input.handEditStatus);
}

/**
 * The single wording of every drift claim. `heal`, `suite-status` and
 * `preflight` all print the SAME claim for the same state+declaration — a
 * third surface wording the same fact differently is exactly the defect this
 * single source exists to prevent.
 *
 * Callers own two things this function deliberately does not: their own
 * indentation, and their own surface-specific render guard (a row that already
 * carries its own instruction must not gain a second, competing one). This
 * answers only "what does this state say?"; an undeclared `current` row says
 * nothing, while a declared `current` row is the contradiction cell.
 */
export function planDriftClaim(state: PlanDriftState, slug: string): string | undefined {
  if (state.handFinishedStale === true) {
    return buildHandFinishedStaleDisclosure();
  }
  if (state.handFinishedDeclared === true) {
    if (state.verdict === 'unknown') {
      return buildHandFinishedDisclosure(slug);
    }
    return buildHandFinishedConflictDisclosure();
  }
  if (state.relocatedSpec !== undefined) {
    return `ⓘ this spec lives at the non-default path ${state.relocatedSpec.specPath}; generation drift was not assessed for this file. Nothing is required — do not run scaffold with --force to "fix" this, because it would create a second file at the default path.`;
  }
  switch (state.verdict) {
    case 'drifted':
      return `⚠ plan/spec drift — the plan changed while this spec remains untouched machine output; run "replaytest scaffold ${slug} --force" to re-scaffold.`;
    case 'accepted-unverified':
      return 'ⓘ plan/spec state: accepted but unverified — this accepted plan was recorded, while the spec has hand edits.';
    case 'unverified':
      return state.handEditStatus === 'unknown'
        ? 'ⓘ plan/spec state: unverified — the plan changed; replaytest has no hand-edit baseline for this spec, so it cannot verify the delta was applied.'
        : 'ⓘ plan/spec state: unverified — the plan changed and the spec has hand edits, so replaytest cannot verify the delta was applied.';
    case 'unknown':
      return `ⓘ plan/spec state: unknown — this tool has no record of what it last generated for this spec; run "replaytest scaffold ${slug} --force" to create that record when overwriting the spec is intended.`;
    default:
      return undefined;
  }
}

/** Adds relocation provenance without changing the default-path drift result. */
export function withRelocatedSpec(state: PlanDriftState, specPath: string): PlanDriftState {
  return { ...state, relocatedSpec: { specPath, driftAssessed: false } };
}

/** Resolver-only filesystem seam; callers can consume this without bare fs reads. */
export interface PlanDriftReadSeam {
  readFile?: (filePath: string) => string;
  pathExists?: (filePath: string) => boolean;
}

export interface ResolvePlanDriftOptions extends PlanDriftReadSeam {
  slug: string;
  plansDir: string;
  generatedTestsDir: string;
  workspaceRoot: string;
  recordPath: string;
  /**
   * A batch caller may load this immutable record once and share it across
   * slugs. `recordLoaded` distinguishes a missing/invalid record from a
   * caller that intentionally left record loading to this resolver.
   */
  record?: SpecEmittedHashes;
  /**
   * Only has to disambiguate "loaded it and there was none" from "left the
   * loading to you". A supplied `record` is honored with or without it, so
   * there is no silent-fallback trap for the next caller.
   */
  recordLoaded?: boolean;
  /** Loaded once by the command boundary; never read from disk by this resolver. */
  handFinishedSlugs?: ReadonlySet<string>;
}

function applyHandFinishedDeclaration(state: PlanDriftState, declared: boolean, specExists: boolean): PlanDriftState {
  if (!declared) return state;
  return specExists ? { ...state, handFinishedDeclared: true } : { ...state, handFinishedStale: true };
}

/**
 * Resolves plan drift for the canonical generated-spec path only. Comparison
 * (`--out`) entries intentionally cannot become this slug's live baseline.
 */
export function resolvePlanDrift(opts: ResolvePlanDriftOptions): PlanDriftState {
  const readFile = opts.readFile ?? readFileFromFs;
  const pathExists = opts.pathExists ?? pathExistsFromFs;
  const planPath = path.join(opts.plansDir, `${opts.slug}.plan.json`);
  const specPath = path.join(opts.generatedTestsDir, `${opts.slug}.spec.ts`);

  // These three exits happen BEFORE the record is consulted, so neither axis
  // was evaluated: the state omits `handEditStatus` rather than inventing one.
  if (!pathExists(planPath)) return unknownPlanDriftState();

  let rawPlan: string;
  try {
    rawPlan = readFile(planPath);
  } catch {
    return unknownPlanDriftState();
  }
  const parsedPlan = parseSidecarJson(rawPlan);
  if (parsedPlan.kind !== 'sidecar') return unknownPlanDriftState();

  // A caller-supplied record is authoritative; otherwise the read goes through
  // the SAME injected seam as the plan/spec reads, so a caller that injects a
  // seam never gets mixed real-disk/injected provenance.
  const recordLoaded = opts.recordLoaded === true || opts.record !== undefined;
  const record = recordLoaded ? opts.record : readSpecEmittedHashes(opts.recordPath, readFile);
  const entry = record?.entries.find(
    (candidate) => candidate.slug === opts.slug && candidate.specPath === toRelativePath(opts.workspaceRoot, specPath),
  );
  const specExists = pathExists(specPath);

  // The spec axis is evaluable from ANY entry carrying a spec baseline —
  // including a v1 record from before plan baselines with no plan hash, which is every slug of
  // every existing install on first run after upgrade. Computing it before the
  // plan-axis join keeps the published state from asserting `unknown` about an
  // axis this function can prove two lines away.
  // read contract intentionally not wired into drift verdicts — the no-claim floor; the rider slice wires it.
  const handEditStatus = resolveSpecHandEditStatus(entry, specPath, readFile);
  // An unknown/absent hash domain is deliberately not trusted as a baseline.
  const baselinePlanSha256 = entry?.planHashDomain === PLAN_HASH_DOMAIN ? entry.planSha256 : undefined;

  const state = computePlanDriftState({
    baselinePlanSha256,
    currentPlanSha256: hashPlanSidecarContent(parsedPlan.sidecar),
    acceptedPlanSha256: entry?.acceptedPlanSha256,
    handEditStatus,
  });
  return applyHandFinishedDeclaration(state, opts.handFinishedSlugs?.has(opts.slug) === true, specExists);
}

/** The exact `checkSpecHandEdits` evaluation, over an already-selected entry and the resolver's read seam. */
function resolveSpecHandEditStatus(
  entry: SpecEmittedHashEntry | undefined,
  specPath: string,
  readFile: (filePath: string) => string,
): SpecHandEditStatus {
  return inspectSpecHandEdits(entry, specPath, readFile, false).status;
}

/** Hashes the exact plan projection domain: all sidecar content except source provenance. */
export function hashPlanSidecarContent(sidecar: Sidecar): string {
  return hashSpecContent(canonicalJson({ ...sidecar, source: undefined }));
}

export function specEmittedHashesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.replaytest', 'state', 'spec-emitted-hashes.json');
}

export function readSpecEmittedHashes(
  recordPath: string,
  /** Optional read seam so a batch caller can share one injected filesystem with the resolver. */
  readFile: (filePath: string) => string = readFileFromFs,
): SpecEmittedHashes | undefined {
  let raw: string;
  try {
    raw = readFile(recordPath);
  } catch {
    return undefined;
  }
  return parseSpecEmittedHashes(raw);
}

export function checkSpecHandEdits(
  recordPath: string,
  workspaceRoot: string,
  slug: string,
  specPath: string,
): SpecHandEditCheck {
  const record = readSpecEmittedHashes(recordPath);
  const entry = record?.entries.find((candidate) => candidate.slug === slug && candidate.specPath === toRelativePath(workspaceRoot, specPath));
  return inspectSpecHandEdits(entry, specPath, readFileFromFs, true);
}

function inspectSpecHandEdits(
  entry: SpecEmittedHashEntry | undefined,
  specPath: string,
  readFile: (filePath: string) => string,
  includeConfirmedFixes: boolean,
): SpecHandEditCheck {
  if (entry === undefined) return { status: 'unknown' };

  let source: string;
  try {
    source = readFile(specPath);
  } catch {
    return { status: 'unknown', entry };
  }
  return {
    status: hashSpecContent(source) === entry.specSha256 ? 'stamped-clean' : 'hand-edited',
    entry,
    ...(includeConfirmedFixes && entry.confirmedFixes !== undefined ? { confirmedFixes: checkConfirmedFixes(source, entry) } : {}),
  };
}

/**
 * Re-reads the scoped confirmation without trusting its old byte offset. A
 * confirmation is usable only while exactly one fresh-locator occurrence
 * remains, the step anchor still locates an action line, and that line still
 * hashes identically. The v1 drift envelope deliberately does not publish a
 * second customer-facing claim, so this result stays on the existing
 * hand-edit-check contract for the future claim rider.
 */
export function checkConfirmedFixes(
  source: string,
  entry: Pick<SpecEmittedHashEntry, 'confirmedFixes'>,
): ConfirmedFixCheck {
  const fixes = entry.confirmedFixes;
  if (fixes === undefined || fixes.length === 0) return { status: 'current', staleCount: 0 };

  for (const fix of fixes) {
    const occurrences = findAnchoredOccurrences(source, fix.anchor);
    if (occurrences.length !== 1) {
      return {
        status: 'stale',
        staleCount: occurrences.length,
        reason: `expected one fresh-locator occurrence, found ${occurrences.length}`,
      };
    }
    if (fix.stepIndex === undefined) {
      return { status: 'stale', staleCount: 1, reason: 'the confirmation has no step anchor' };
    }
    const located = locateStepLineByIndex(source, fix.stepIndex, 'fill') ?? locateStepLineByIndex(source, fix.stepIndex, 'click');
    if (located === undefined || !isFreshActionLine(located.snippet, fix.anchor)) {
      return { status: 'stale', staleCount: 1, reason: 'the step anchor is not the fresh-locator action line' };
    }
    const occurrence = occurrences[0];
    if (occurrence === undefined || occurrence.snippet.trim() !== located.snippet || hashSpecContent(located.snippet) !== fix.lineHash) {
      return { status: 'stale', staleCount: 1, reason: 'the confirmed action line changed' };
    }
  }

  return { status: 'current', staleCount: 0 };
}

function isFreshActionLine(line: string, anchor: string): boolean {
  const trimmed = line.trim();
  const prefix = `await page.${anchor}.`;
  return trimmed.startsWith(prefix) && /\.(?:fill|click|selectOption|check)\(/.test(trimmed.slice('await page.'.length));
}

/** Record a new baseline only after replaytest has actually written the spec. */
export function stampEmittedSpecHash(
  recordPath: string,
  workspaceRoot: string,
  slug: string,
  specPath: string,
  sidecar: Sidecar | undefined,
  generatedAt: string,
  writer: ArtifactWriter,
): SpecEmittedHashEntry {
  const source = fs.readFileSync(specPath, 'utf8');
  const relativeSpecPath = toRelativePath(workspaceRoot, specPath);
  const prior = readSpecEmittedHashes(recordPath);
  const priorEntry = prior?.entries.find(
    (candidate) => candidate.slug === slug && candidate.specPath === relativeSpecPath,
  );
  const entry: SpecEmittedHashEntry = {
    slug,
    specPath: relativeSpecPath,
    specSha256: hashSpecContent(source),
    generatedAt,
    // A real applied/scaffold write rebuilds the whole-file baseline. Any
    // prior scoped confirmation is intentionally dropped because its narrower
    // fact is redundant after replaytest authored the complete file again.
    // Withholding a plan baseline (a `fix-selector` write whose plan
    // mirror could not be synchronized) means NOT REFRESHED, never DELETED.
    // Destroying a valid baseline would strand the pair on the generic
    // `scaffold --force` advisory, whose remedy re-generates the spec from the
    // very plan that was never synchronized — reverting the repair that just
    // ran. `acceptedPlanSha256` rides along because it is part of the same
    // plan axis: dropping it alone would silently demote a calm
    // `accepted-unverified` row to an actionable `unverified` one. `acceptedAt`
    // rides with it for the same reason — the two are one acceptance fact, and
    // keeping the hash while dropping its timestamp would leave the record
    // saying a plan was accepted at no particular time.
    ...(sidecar === undefined
      ? {
          ...(priorEntry?.acceptedAt === undefined ? {} : { acceptedAt: priorEntry.acceptedAt }),
          ...(priorEntry?.planSha256 === undefined ? {} : { planSha256: priorEntry.planSha256 }),
          ...(priorEntry?.planHashDomain === undefined ? {} : { planHashDomain: priorEntry.planHashDomain }),
          ...(priorEntry?.acceptedPlanSha256 === undefined ? {} : { acceptedPlanSha256: priorEntry.acceptedPlanSha256 }),
        }
      : {
          planSha256: hashPlanSidecarContent(sidecar),
          planHashDomain: PLAN_HASH_DOMAIN,
        }),
  };
  // Keep historical baselines rather than evicting renamed/deleted slugs. See
  // the file header for the bounded-growth and stale-entry rationale.
  const entries = (prior?.entries ?? []).filter(
    (candidate) => candidate.slug !== slug || candidate.specPath !== entry.specPath,
  );
  entries.push(entry);
  writeSpecEmittedHashes(recordPath, entries, writer);
  return entry;
}

/**
 * Refresh only the plan axis after `already-applied + --apply`. This never
 * reads or rewrites the spec baseline: replaytest did not author those bytes.
 * A marker-less spec has no valid place for this scoped fact, so it is left
 * completely absent rather than manufacturing the original false baseline.
 */
export function refreshPlanAxisAfterAlreadyApplied(
  recordPath: string,
  workspaceRoot: string,
  slug: string,
  specPath: string,
  sidecar: Sidecar,
  confirmedFixes: readonly ConfirmedFix[],
  writer: ArtifactWriter,
): SpecEmittedHashEntry | undefined {
  const relativeSpecPath = toRelativePath(workspaceRoot, specPath);
  const prior = readSpecEmittedHashes(recordPath);
  const priorEntry = prior?.entries.find(
    (candidate) => candidate.slug === slug && candidate.specPath === relativeSpecPath,
  );
  if (priorEntry === undefined) return undefined;

  const entry: SpecEmittedHashEntry = {
    ...priorEntry,
    planSha256: hashPlanSidecarContent(sidecar),
    planHashDomain: PLAN_HASH_DOMAIN,
    ...(confirmedFixes.length === 0
      ? {}
      : { confirmedFixes: mergeConfirmedFixes(priorEntry.confirmedFixes ?? [], confirmedFixes) }),
  };
  const entries = (prior?.entries ?? []).map((candidate) =>
    candidate.slug === slug && candidate.specPath === relativeSpecPath ? entry : candidate,
  );
  writeSpecEmittedHashes(recordPath, entries, writer);
  return entry;
}

/**
 * Acceptance promotes a plan, not a spec. Preserve the existing generation
 * baseline so a hand-edited spec stays hand-edited after plan promotion; only
 * the observed accepted plan is recorded. A marker-less pre-existing spec
 * stays unknown rather than being falsely blessed as generated.
 */
export function markSpecHashAccepted(
  recordPath: string,
  workspaceRoot: string,
  slug: string,
  specPath: string,
  acceptedPlan: Sidecar,
  acceptedAt: string,
  writer: ArtifactWriter,
): SpecHandEditCheck {
  const check = checkSpecHandEdits(recordPath, workspaceRoot, slug, specPath);
  if (check.entry === undefined) return check;

  const prior = readSpecEmittedHashes(recordPath);
  const entries = (prior?.entries ?? []).map((entry) =>
    entry.slug === slug && entry.specPath === check.entry?.specPath
      ? { ...entry, acceptedAt, acceptedPlanSha256: hashPlanSidecarContent(acceptedPlan) }
      : entry,
  );
  writeSpecEmittedHashes(recordPath, entries, writer);
  return check;
}

/**
 * Harvests and removes a slug's spec-emitted-hash entry — the `retire` verb's
 * state-cleanup step. Returns the harvested entry (verbatim, for embedding in
 * `retirement.json`) and writes the remaining entries back. Returns `undefined`
 * when no entry exists for this slug (a legacy spec with no baseline leaves
 * nothing to harvest). The reversal recipe re-inserts the harvested entry so
 * drift round-trips to its pre-retirement verdict, not `unknown`.
 */
export function removeSpecEmittedHashEntry(
  recordPath: string,
  slug: string,
  canonicalSpecPathValue: string | undefined,
  writer: ArtifactWriter,
): SpecEmittedHashEntry | undefined {
  const prior = readSpecEmittedHashes(recordPath);
  if (prior === undefined) return undefined;
  const matches = (entry: SpecEmittedHashEntry): boolean => entry.slug === slug &&
    (canonicalSpecPathValue === undefined || entry.specPath === canonicalSpecPathValue);
  const harvested = prior.entries.find(matches);
  const remaining = prior.entries.filter((entry) => !matches(entry));
  if (remaining.length === prior.entries.length) return undefined; // no entry for this slug
  writeSpecEmittedHashes(recordPath, remaining, writer);
  return harvested;
}

function planDriftState(
  verdict: PlanDriftVerdict,
  handEditStatus: SpecHandEditStatus,
  planIsReadable = true,
): PlanDriftState {
  return { verdict, keying: PLAN_DRIFT_KEYING, handEditStatus, planIsReadable };
}

/**
 * The state for a pair whose live plan could not be read at all, so NEITHER
 * axis was evaluated. `handEditStatus` is omitted on purpose: silence about an
 * unevaluated axis beats a fabricated `'unknown'`.
 */
export function unknownPlanDriftState(): PlanDriftState {
  return { verdict: 'unknown', keying: PLAN_DRIFT_KEYING, planIsReadable: false };
}

function readFileFromFs(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function pathExistsFromFs(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function parseSpecEmittedHashes(raw: string): SpecEmittedHashes | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSpecEmittedHashes(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** JSON has no meaningful object-key order; arrays retain substantive order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeJson(child)]),
  );
}

function writeSpecEmittedHashes(recordPath: string, entries: SpecEmittedHashEntry[], writer: ArtifactWriter): void {
  const sorted = [...entries].sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const record: SpecEmittedHashes = {
    schema: SPEC_EMITTED_HASHES_SCHEMA,
    algorithm: 'sha256',
    entries: sorted,
  };
  writer('spec-emitted-hashes', recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function mergeConfirmedFixes(
  priorFixes: readonly ConfirmedFix[],
  newFixes: readonly ConfirmedFix[],
): ConfirmedFix[] {
  const merged: ConfirmedFix[] = [];
  for (const fix of [...priorFixes, ...newFixes]) {
    const existingIndex = merged.findIndex((candidate) => candidate.anchor === fix.anchor && candidate.lineHash === fix.lineHash);
    if (existingIndex === -1) {
      merged.push(fix);
    } else {
      // Re-confirmation updates the timestamp and current relocation hints,
      // while the anchor + line hash remains the identity of the fact.
      merged[existingIndex] = fix;
    }
  }
  return merged;
}

function toRelativePath(workspaceRoot: string, specPath: string): string {
  const relative = path.relative(workspaceRoot, specPath);
  return relative === '' ? path.basename(specPath) : relative.split(path.sep).join('/');
}

function isSpecEmittedHashes(value: unknown): value is SpecEmittedHashes {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SpecEmittedHashes>;
  return (
    record.schema === SPEC_EMITTED_HASHES_SCHEMA &&
    record.algorithm === 'sha256' &&
    Array.isArray(record.entries) &&
    record.entries.every(isSpecEmittedHashEntry)
  );
}

function isSpecEmittedHashEntry(value: unknown): value is SpecEmittedHashEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SpecEmittedHashEntry>;
  if (typeof candidate.slug !== 'string') return false;
  if (typeof candidate.specPath !== 'string') return false;
  if (typeof candidate.specSha256 !== 'string') return false;
  if (typeof candidate.generatedAt !== 'string') return false;
  if (!isOptionalString(candidate.acceptedAt)) return false;
  if (!isOptionalString(candidate.planSha256)) return false;
  if (!isOptionalString(candidate.planHashDomain)) return false;
  if (!isOptionalString(candidate.acceptedPlanSha256)) return false;
  return candidate.confirmedFixes === undefined || isConfirmedFixes(candidate.confirmedFixes);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isConfirmedFixes(value: unknown): value is ConfirmedFix[] {
  return Array.isArray(value) && value.every((fix) => {
    if (typeof fix !== 'object' || fix === null) return false;
    const candidate = fix as Partial<ConfirmedFix>;
    return (
      typeof candidate.anchor === 'string' &&
      (candidate.stepIndex === undefined || (typeof candidate.stepIndex === 'number' && Number.isInteger(candidate.stepIndex) && candidate.stepIndex >= 0)) &&
      typeof candidate.offset === 'number' &&
      Number.isInteger(candidate.offset) &&
      candidate.offset >= 0 &&
      typeof candidate.lineHash === 'string' &&
      typeof candidate.confirmedAt === 'string'
    );
  });
}
