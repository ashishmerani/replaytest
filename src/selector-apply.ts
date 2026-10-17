/**
 * Surgical selector repair from the last persisted heal envelope.  This is
 * deliberately local-only: it trusts the diagnosis already shown to the
 * customer and changes one emitted `page.<locator>.` occurrence at most.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { emitArtifact } from './artifact-registry.js';
import { collectGeneratedSpecHeaders } from './generated-spec-headers.js';
import { createStatePublicationLedger, releaseStateLockWithDisclosure, writeStateFile, type StatePublicationLedger } from './state-writes.js';
import { acquireStateLock, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, verifyStateLock, type StateLockHandle } from './state-lock.js';
import { TOOL_NAME } from './cli/constants.js';
import { buildHandFinishedApplyRefusal, buildHandFinishedDisclosure } from './hand-finished.js';
import {
  EVIDENCE_PATH_REFUSAL_MESSAGE,
  createWorkspacePathIdentity,
  isHealLatestV2,
  matchWorkspacePath,
} from './workspace-path-identity.js';
import { readLatestRecordedRun, timestampMs } from './run-staleness.js';
import { retirementRecoveryMessage } from './cli/retired-awareness.js';
import { buildPrivacyDisclosure, PRIVACY_DISCLOSURE_REQUIRED_COPY, type PrivacyDisclosure } from './pii-lint.js';
import {
  classifyLocatorRung,
  classifyPatchActionability,
  parsePersistedTriageEvidence,
  type PersistedTriageEvidence,
} from './triage-evidence.js';
import { SUITE_SCAN_MAX_DIRECTORIES, SUITE_SCAN_MAX_FILES } from './suite-scan.js';
export type SelectorApplyRefusalCode =
  | 'missing-evidence'
  | 'invalid-evidence'
  | 'stale-evidence'
  | 'no-selector-change'
  | 'multiple-patches'
  | 'empty-old-locator'
  | 'empty-fresh-locator'
  | 'missing-spec'
  | 'fix-selector-spec-scan-capped'
  | 'fix-selector-spec-ambiguous'
  | 'unreadable-spec'
  | 'old-locator-absent'
  | 'multiple-occurrences'
  | 'occurrence-out-of-range'
  // Opt-in `--from-triage-verdict` mode. The verdict site can't be found
  // even after tolerating a hand-edit (never guess), or the spec is in a
  // partial/divergent state that needs an explicit site pick before converging.
  | 'verdict-site-unlocatable'
  | 'verdict-divergent'
  | 'verdict-stability-unsupported'
  | 'stability-candidate-unavailable'
  | 'hand-finished-declared'
  | 'state-lock-held'
  | 'state-lock-fenced'
  | 'retirement-recovery-required'
  | 'privacy-disclosure-required'
  | 'write-failed';

export interface SelectorApplyRecord {
  /** Retire-owned identity envelope; never infer this from a slug. */
  rowKind: 'selector-applies';
  /** Workspace-relative, separator-normalized identity of the patched spec. */
  canonicalSpecPath: string;
  keyVersion: 1;
  slug: string;
  oldLocator: string;
  freshLocator: string;
  specPath: string;
  appliedAt: string;
  privacyOverride?: {
    code: 'privacy-disclosure-required';
    flag: '--allow-privacy-disclosure';
    consentedAt: string;
    findings: readonly PrivacyDisclosure['findings'][number][];
  };
}

export interface SelectorOccurrence {
  number: number;
  /** Byte offset of the emitted `page.<oldLocator>.` anchor in the spec. */
  offset: number;
  /** The complete source line containing the anchored occurrence. */
  snippet: string;
  /**
   * True when the persisted step anchor corroborates this
   * occurrence as the one the verdict's step describes — display-only. It
   * never selects/applies an occurrence by itself; an explicit `--occurrence`
   * is still required whenever more than one occurrence exists.
   */
  anchorMatch?: boolean;
}

/** A changed match that was filtered out of the actionable set, kept for honest display. */
export interface InformationalPatch {
  oldLocator: string;
  freshLocator: string;
  reason: string;
}

interface SelectorApplyEvidenceNotice {
  /** A separate persisted source was found but refused as unsafe to join. */
  evidenceNotice?: string;
}

export interface SelectorApplyPreview extends SelectorApplyEvidenceNotice {
  kind: 'preview';
  slug: string;
  oldLocator: string;
  freshLocator: string;
  specPath: string;
  /** Absolute internal path used for every spec read and write. */
  resolvedSpecPath: string;
  /** Separator-normalized workspace-relative path used on customer surfaces. */
  specDisplayPath: string;
  /** False when slug-header discovery selected a non-default file. */
  isDefaultSpecPath: boolean;
  occurrences: SelectorOccurrence[];
  selectedOccurrence?: number;
  /** Weaker-rung / position-basis matches shown but not proposed. */
  informational?: InformationalPatch[];
  privacyDisclosure?: PrivacyDisclosure;
  /** Explicitly requested, fresh-validated recorded-rung downgrade. */
  stabilityDowngrade?: { winnerStrategy: string; alternateStrategy: string };
}

export interface SelectorApplySuccess extends Omit<SelectorApplyPreview, 'kind' | 'selectedOccurrence'> {
  kind: 'applied';
  selectedOccurrence: number;
  appliedAt: string;
  recordPath?: string;
  warning?: string;
}

export interface SelectorApplyRefusal extends SelectorApplyEvidenceNotice {
  kind: 'refusal';
  code: SelectorApplyRefusalCode;
  message: string;
  exitCode: 1;
  occurrences?: SelectorOccurrence[];
  /** The filtered informational matches this refusal is reporting on, if any. */
  informational?: InformationalPatch[];
  privacyDisclosure?: PrivacyDisclosure;
}

/**
 * The `--from-triage-verdict` no-op short-circuit. The hand-edit already
 * holds the diagnosed fresh locator, so the verdict is satisfied — a SUCCESS
 * (exit 0), never a refusal, and it writes nothing.
 */
export interface SelectorApplyAlreadyApplied extends SelectorApplyEvidenceNotice {
  kind: 'already-applied';
  slug: string;
  oldLocator: string;
  freshLocator: string;
  specPath: string;
  resolvedSpecPath: string;
  specDisplayPath: string;
  isDefaultSpecPath: boolean;
  /** The fresh-locator occurrences the hand-edit already left in the spec. */
  occurrences: SelectorOccurrence[];
}

export type SelectorApplyResult =
  | SelectorApplyPreview
  | SelectorApplySuccess
  | SelectorApplyAlreadyApplied
  | SelectorApplyRefusal;

export interface SelectorApplyOptions {
  slug: string;
  /** `false` is the default, deliberate dry-run posture. */
  apply?: boolean;
  /**
   * Opt-in verdict-apply mode. When `true`, the site is located tolerantly:
   * the diagnosed OLD locator string is no longer required to survive a
   * hand-edit. Absent/`false` keeps today's strict anchor-required behavior
   * byte-for-byte. See the location branch in `applyPersistedSelectorPatch`.
   */
  fromTriageVerdict?: boolean;
  /** Fidelity is the default; stability swaps in a fresh-validated recorded alternate after patch selection. */
  prefer?: 'fidelity' | 'stability';
  /** One-based occurrence selected by the customer. */
  occurrence?: number;
  workspaceRoot?: string;
  generatedTestsDir?: string;
  healLatestPath?: string;
  /** Separate, single-slug triage store; never aliases the heal envelope. */
  triageEvidenceDir?: string;
  /** The last heal run's compact metadata, used by the shared staleness guard. */
  lastRunStatePath?: string;
  /** The raw Playwright JSON reporter output, also a staleness precedent. */
  reporterLastRunPath?: string;
  selectorAppliesPath?: string;
  now?: () => Date;
  /** Loaded once by the command boundary; never reads the registry here. */
  handFinishedSlugs?: ReadonlySet<string>;
  /** Bound by a caller holding the cross-verb lease; direct apply callers acquire one. */
  stateLockHandle?: StateLockHandle;
  publicationLedger?: StatePublicationLedger;
  stealStateLock?: boolean;
  retiredDir?: string;
  /** Per-invocation consent for a PII-shaped locator entering a committed spec. */
  allowPrivacyDisclosure?: boolean;
  /** Relocated-spec scan progress; command boundaries route this to stderr. */
  progress?: (line: string) => void;
  /** Test seam for proving default-path calls do not enumerate. */
  collectGeneratedSpecHeaders?: typeof collectGeneratedSpecHeaders;
}

interface SelectorPatch {
  oldLocator: string;
  freshLocator: string;
  /** How the sidecar↔fresh steps were paired; `position` → informational by default. */
  basis?: 'action-label' | 'position';
  /** Fresh-validated candidate from recorded sidecar alternates, absent on legacy evidence. */
  stabilityCandidate?: { strategy: string; locator: string };
  /**
   * The sidecar step this patch was paired against, when the
   * source evidence carried one. LOCATION only — used to corroborate/locate a
   * patch site in the spec, never to change which outcome (the user-locked
   * taxonomy) applies or to grant new apply authority. Absent for evidence
   * persisted before this optional anchor existed. Both writers — triage's `PersistedSelectorPatch`
   * and heal's embedded `SelectorMatch` — are read identically here.
   */
  stepAction?: 'fill' | 'click';
  stepLabel?: string;
  stepIndex?: number;
}

interface PersistedSelectorEvidence {
  source: 'heal' | 'triage';
  displayPath: string;
  generatedAt?: string;
  patches: SelectorPatch[];
  freshnessChecked?: boolean;
  failingLocator?: string;
  /** An unsafe heal row existed, while this selected evidence came from triage. */
  evidenceNotice?: string;
}

interface ResolvedPaths {
  workspaceRoot: string;
  resolvedSpecPath: string;
  specDisplayPath: string;
  isDefaultSpecPath: boolean;
  healLatestPath: string;
  healLatestDisplayPath: string;
  triageEvidenceDir: string;
  triageEvidenceDisplayPath: string;
  lastRunStatePath: string;
  reporterLastRunPath: string;
  selectorAppliesPath: string;
  selectorAppliesDisplayPath: string;
}

/**
 * Reads `healJsonEnvelope`'s persisted shape, whose relevant source is
 * `slugs[].report.evidence.selectorFreshness.changed[]`.  Kept structural so
 * this local command does not import triage/heal (or any provider adapter).
 */
export interface HealEnvelopePathMatchOptions {
  expectedSpecPath: string;
  workspaceRoot: string;
}

type HealEnvelopePatchLookup =
  | { kind: 'missing' }
  | { kind: 'refused' }
  | { kind: 'patches'; patches: SelectorPatch[] };

function patchesFromHealEnvelope(
  value: unknown,
  slug: string,
  pathMatch?: HealEnvelopePathMatchOptions,
): HealEnvelopePatchLookup {
  if (!isRecord(value) || !Array.isArray(value.slugs)) return { kind: 'missing' };
  const outcomes = value.slugs.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.slug === slug);
  if (outcomes.length === 0) return { kind: 'missing' };
  let outcome: Record<string, unknown> | undefined = outcomes[0];
  if (pathMatch !== undefined) {
    const identity = createWorkspacePathIdentity(pathMatch.workspaceRoot);
    const v2 = isHealLatestV2(typeof value.schema === 'string' ? { schema: value.schema } : undefined);
    outcome = outcomes.find((entry) => {
      if (typeof entry.file !== 'string') return !v2;
      const match = matchWorkspacePath(entry.file, pathMatch.expectedSpecPath, identity, !v2);
      return match === 'exact' || match === 'legacy-suffix';
    });
    if (outcome === undefined) return { kind: 'refused' };
  }
  if (outcome === undefined) return { kind: 'missing' };
  if (!isRecord(outcome.report) || !isRecord(outcome.report.evidence)) return { kind: 'missing' };

  const freshness = outcome.report.evidence.selectorFreshness;
  if (!isRecord(freshness) || !Array.isArray(freshness.changed)) return { kind: 'missing' };

  return { kind: 'patches', patches: freshness.changed
    .filter((change): change is Record<string, unknown> => isRecord(change))
    .filter(
      (change): change is Record<string, unknown> =>
        typeof change.oldLocator === 'string' && typeof change.freshLocator === 'string',
    )
    .map((change) => ({
      oldLocator: change.oldLocator as string,
      freshLocator: change.freshLocator as string,
      // The heal envelope serializes the full SelectorMatch, whose `match` field
      // is the pairing basis a position-basis noise patch is filtered on.
      ...(change.match === 'action-label' || change.match === 'position' ? { basis: change.match } : {}),
      ...(isStabilityCandidate(change.stabilityCandidate) ? { stabilityCandidate: change.stabilityCandidate } : {}),
      // The heal envelope already embeds the full SelectorMatch — its
      // `action`/`sidecarLabel`/`sidecarIndex` fields ARE the step anchor, no
      // heal-side writer change needed. Read them under the same names this
      // module uses internally (`stepAction`/`stepLabel`/`stepIndex`).
      ...(change.action === 'fill' || change.action === 'click' ? { stepAction: change.action } : {}),
      ...(typeof change.sidecarLabel === 'string' ? { stepLabel: change.sidecarLabel } : {}),
      ...(typeof change.sidecarIndex === 'number' && Number.isInteger(change.sidecarIndex) && change.sidecarIndex >= 0
        ? { stepIndex: change.sidecarIndex }
        : {}),
    })) };
}

/**
 * The optional third argument is deliberately overload-preserving for the
 * display-only caller. Supplying it makes this apply path refuse a
 * foreign/missing v2 `slugs[].file`; omitting it retains legacy behavior.
 */
export function selectorPatchesFromHealEnvelope(
  value: unknown,
  slug: string,
  pathMatch?: HealEnvelopePathMatchOptions,
): SelectorPatch[] | undefined {
  const result = patchesFromHealEnvelope(value, slug, pathMatch);
  return result.kind === 'patches' ? result.patches : undefined;
}

/** Finds non-overlapping occurrences of the exact form the scaffold emitter writes. */
export function findAnchoredOccurrences(source: string, oldLocator: string): SelectorOccurrence[] {
  if (oldLocator.length === 0) return [];
  const anchor = `page.${oldLocator}.`;
  const occurrences: SelectorOccurrence[] = [];
  let offset = 0;

  while (offset <= source.length - anchor.length) {
    const found = source.indexOf(anchor, offset);
    if (found === -1) break;
    occurrences.push({
      number: occurrences.length + 1,
      offset: found,
      snippet: sourceLineAt(source, found),
    });
    offset = found + anchor.length;
  }

  return occurrences;
}

/**
 * Scans the generated spec's `await page.<expr>.<method>(` action
 * lines in source order (fill/click/selectOption/check — `sidecar.ts`
 * `renderSidecarStep`/`renderSidecarFillLines` never emits any other method
 * for a step) and returns the `stepIndex`-th one — 0-based, mirroring the
 * ORIGINAL sidecar's `steps` array index the patch was paired against.
 *
 * A step with an unrecoverable selector emits a fixed TODO comment INSTEAD of
 * an action line (`sidecar.ts` `renderSidecarStep`), so those lines count as
 * steps too — otherwise every step after one would locate one
 * line early, and a same-action neighbor would slip past the sanity check
 * below. The result stays gated by that sanity check regardless: the located
 * line's method must be consistent with `expectedAction` ('fill' also covers
 * the `selectOption`/`check` emission variants a `fill`-action step can
 * render; 'click' must be a literal `.click(`), and a TODO placeholder line
 * can never BE the located step (its selector is unrecoverable — no verdict
 * pairs against it). A mismatch means we don't trust the position and return
 * `undefined` rather than naming the wrong line — this function only ever
 * INFORMS a refusal message, never selects an occurrence to apply.
 */
export function locateStepLineByIndex(
  source: string,
  stepIndex: number,
  expectedAction: 'fill' | 'click',
): { lineNumber: number; snippet: string } | undefined {
  const actionLine = /^\s*await page\.(.+)\.(fill|click|selectOption|check)\(/;
  // Mirrors sidecar.ts's exact no-selector placeholder wording — a step that
  // rendered no driving line still occupies its slot in the steps[] order.
  const noSelectorTodo = '// TODO: no selector recoverable from the recording for this step';
  const lines = source.split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === noSelectorTodo) {
      if (seen === stepIndex) return undefined;
      seen += 1;
      continue;
    }
    const match = actionLine.exec(lines[index]);
    if (match === null) continue;
    if (seen === stepIndex) {
      const method = match[2];
      const matches = expectedAction === 'fill' ? method !== 'click' : method === 'click';
      return matches ? { lineNumber: index + 1, snippet: lines[index].trim() } : undefined;
    }
    seen += 1;
  }
  return undefined;
}

/**
 * Display-only corroboration. When more than one occurrence of the same
 * locator exists, and every one of them can be attributed to a DISTINCT
 * persisted patch (same `oldLocator`, each carrying a `stepIndex`) whose count
 * exactly matches the occurrence count, rank both by (file offset) and (step
 * order) and mark the occurrence whose rank matches `targetStepIndex`. Any
 * mismatch in counts, a missing anchor, or a duplicate `stepIndex` bails out
 * silently (fail open — never guesses); the function only ever ADDS an
 * `anchorMatch: true` flag, it never reorders, drops, or auto-selects.
 */
export function annotateOccurrencesWithAnchor(
  occurrences: SelectorOccurrence[],
  allPatches: readonly { oldLocator: string; stepIndex?: number }[],
  targetOldLocator: string,
  targetStepIndex: number | undefined,
): SelectorOccurrence[] {
  if (occurrences.length <= 1 || targetStepIndex === undefined) return occurrences;

  const sameLocatorStepIndexes = allPatches
    .filter((candidate) => candidate.oldLocator === targetOldLocator && candidate.stepIndex !== undefined)
    .map((candidate) => candidate.stepIndex as number);
  const distinctStepIndexes = [...new Set(sameLocatorStepIndexes)];
  if (distinctStepIndexes.length !== occurrences.length) return occurrences;

  const sorted = [...distinctStepIndexes].sort((a, b) => a - b);
  const rank = sorted.indexOf(targetStepIndex);
  if (rank === -1) return occurrences;

  return occurrences.map((occurrence, index) => (index === rank ? { ...occurrence, anchorMatch: true } : occurrence));
}

function selectorRebuildAdvice(
  slug: string,
  handFinishedSlugs: ReadonlySet<string> | undefined,
  ordinaryAdvice: string,
): string {
  if (handFinishedSlugs?.has(slug) !== true) return ordinaryAdvice;
  const forceRoute = `run \`${TOOL_NAME} scaffold ${slug} --force\``;
  const withoutForceRoute = ordinaryAdvice.replace(` or ${forceRoute}`, '').replace(forceRoute, '');
  return `${withoutForceRoute} ${buildHandFinishedDisclosure(slug)}`;
}

/** Executes the local, opt-in repair. No network or adapter access occurs here. */
export function applyPersistedSelectorPatch(opts: SelectorApplyOptions): SelectorApplyResult {
  if (opts.apply !== true || opts.stateLockHandle !== undefined) return applyPersistedSelectorPatchUnlocked(opts);
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const stateDir = path.join(workspaceRoot, '.replaytest', 'state');
  let handle: StateLockHandle;
  const publicationLedger = opts.publicationLedger ?? createStatePublicationLedger();
  try {
    handle = acquireStateLock(
      stateDir,
      'fix-selector',
      opts.progress === undefined ? {} : { onProgress: opts.progress },
      opts.stealStateLock === true,
    );
  } catch (error) {
    if (error instanceof StateLockHeldError) return refusal('state-lock-held', stateLockHeldMessage('fix-selector', error.info, error.deadHolder));
    // Preserve the pre-lock optional-hash-refresh behavior for a read-only
    // state directory; contention and timeout remain hard refusals.
    if (typeof error === 'object' && error !== null && ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM')) return applyPersistedSelectorPatchUnlocked(opts);
    throw error;
  }
  try {
    return applyPersistedSelectorPatchUnlocked({ ...opts, stateLockHandle: handle, publicationLedger });
  } catch (error) {
    if (error instanceof StateLockFencedError) return refusal('state-lock-fenced', stateLockFencedMessage('fix-selector'));
    throw error;
  } finally {
    releaseStateLockWithDisclosure(handle, publicationLedger, 'fix-selector', opts.progress);
  }
}

function applyPersistedSelectorPatchUnlocked(opts: SelectorApplyOptions): SelectorApplyResult {
  // This must be the first refusal: verdict mode locates tolerantly and could
  // otherwise return already-applied or reach a write before this unsupported
  // pairing is known. Verdict evidence has no persisted alternate-set contract.
  if (opts.prefer === 'stability' && opts.fromTriageVerdict === true) {
    return refusal(
      'verdict-stability-unsupported',
      'Cannot combine `--prefer stability` with `--from-triage-verdict`: verdict-mode location tolerates hand-edits, while stability selection requires the persisted fresh-validated recorded alternate for the exact patch site. Use `--prefer fidelity` for verdict apply, or apply the verified stability selector by hand.',
    );
  }
  const paths = resolvePaths(opts);
  if ('kind' in paths) return paths;
  if (opts.apply === true && opts.handFinishedSlugs?.has(opts.slug) === true) {
    return refusal('hand-finished-declared', buildHandFinishedApplyRefusal(opts.slug));
  }
  const evidence = readPersistedEvidence(paths, opts.slug);
  if ('kind' in evidence) return evidence;

  const result = ((): SelectorApplyResult => {
  if (!fs.existsSync(paths.resolvedSpecPath)) {
    return refusal(
      'missing-spec',
      `No generated spec was found at ${paths.specDisplayPath}, and no relocated spec carrying this slug header was found. If this slug was never scaffolded, run \`${TOOL_NAME} scaffold ${opts.slug}\` first; otherwise pass the spec path explicitly or restore the spec to its default path.`,
    );
  }

  let source: string;
  try {
    source = fs.readFileSync(paths.resolvedSpecPath, 'utf8');
  } catch (err) {
    // The `missing-spec` branch immediately above already proved the file is on
    // disk, so this is a READING problem, not a missing file — saying so stops
    // the reader hunting for a file that exists. The scaffold route is offered
    // only for the narrow case where it really did vanish between the two
    // checks, which is why it is worded as a conditional, not the first advice.
    return refusal(
      'unreadable-spec',
      `Cannot read ${paths.specDisplayPath} (${describeError(err)}). ` +
        'Confirm the file still exists and is readable (permissions/encoding) — ' +
        'a prior `missing-spec` check already confirmed it existed on disk. ' +
        `If it was deleted or moved since, regenerate it with \`${TOOL_NAME} scaffold ${opts.slug}\`, then retry this selector patch.`,
    );
  }

  const stale = staleEvidenceReason(evidence, paths, paths.resolvedSpecPath);
  if (stale !== undefined) {
    return refusal(
      'stale-evidence',
      `Persisted selector freshness evidence for "${opts.slug}" is stale: ${stale}. ` +
        `Run \`${TOOL_NAME} triage ${opts.slug}\` again before applying a selector patch.`,
    );
  }

  // Partition the persisted changed matches into actionable patches versus
  // informational noise — position-basis pairings and strictly-weaker-rung
  // replacements, with the failing-locator carve-out. fix-selector counts ONLY
  // actionable patches; the noise is shown, never proposed. This is what stops
  // an unenriched fresh session's ladder downgrades from shadowing the one real
  // drift patch (and the sub-case-A divergence terminus) on a live corpus.
  const classified = evidence.patches.map((candidate) => ({
    patch: candidate,
    ...classifyPatchActionability(candidate, evidence.failingLocator),
  }));
  const actionablePatches = classified.filter((entry) => entry.actionable).map((entry) => entry.patch);
  const informational: InformationalPatch[] = classified
    .filter((entry) => !entry.actionable)
    .map((entry) => ({
      oldLocator: entry.patch.oldLocator,
      freshLocator: entry.patch.freshLocator,
      reason: entry.reason ?? 'not proposed as a patch',
    }));

  if (actionablePatches.length === 0) {
    if (informational.length > 0) {
      // Every changed match filtered out as noise -> the honest divergence
      // terminus, not the multi-patch refusal that used to shadow it.
      return refusal(
        'no-selector-change',
        selectorRebuildAdvice(opts.slug, opts.handFinishedSlugs, `Fresh traffic for "${opts.slug}" produced ${informational.length} selector difference(s), but every one is ` +
          `informational (a weaker-rung or position-basis pairing) — none is a safe selector replacement. ` +
          `If this spec still fails, its selector diverged from the plan: restore the recorded selector or run ` +
          `\`${TOOL_NAME} scaffold ${opts.slug} --force\`.`),
        undefined,
        informational,
      );
    }
    if (evidence.freshnessChecked === true) {
      return refusal(
        'no-selector-change',
        selectorRebuildAdvice(opts.slug, opts.handFinishedSlugs, `Fresh traffic still matches the plan for "${opts.slug}", so no selector replacement is safe. ` +
          `If this spec still fails, its selector diverged from the plan: restore the recorded selector or run \`${TOOL_NAME} scaffold ${opts.slug} --force\`.`,
        ),
      );
    }
    return refusal(
      'missing-evidence',
      `No safely replaceable selector freshness evidence was persisted for "${opts.slug}". ` +
        `Run \`${TOOL_NAME} triage ${opts.slug}\` again after a fresh completed journey is available.`,
    );
  }

  // The full set of matches shown-but-not-proposed starts with the
  // classification noise; the branch adds the actionable patches the failing
  // locator did NOT pick so nothing is dropped silently.
  const shownInformational: InformationalPatch[] = [...informational];
  let patch: SelectorPatch | undefined;
  if (actionablePatches.length === 1) {
    patch = actionablePatches[0];
  } else {
    // More than one actionable patch remains. A threaded failing
    // locator selects ITS patch; the multi-patch refusal fires only when the
    // failing locator is absent or ambiguous (matches zero or several patches).
    const failing = evidence.failingLocator;
    const matching = failing === undefined ? [] : actionablePatches.filter((entry) => entry.oldLocator === failing);
    if (matching.length === 1) {
      patch = matching[0];
      for (const other of actionablePatches) {
        if (other !== patch) {
          shownInformational.push({
            oldLocator: other.oldLocator,
            freshLocator: other.freshLocator,
            reason: 'not the failing locator — shown, not proposed',
          });
        }
      }
    } else {
      return refusal(
        'multiple-patches',
        `The latest ${evidence.source} evidence has ${actionablePatches.length} actionable selector patches for "${opts.slug}"` +
          `${informational.length > 0 ? ` (plus ${informational.length} shown as informational)` : ''}, and no failing ` +
          `locator identifies which one broke. This command repairs exactly one patch; review them with ` +
          `\`${TOOL_NAME} triage ${opts.slug}\` and update the intended locator manually, then run heal again.`,
        undefined,
        informational.length > 0 ? informational : undefined,
      );
    }
  }

  if (patch === undefined || patch.oldLocator.length === 0) {
    return refusal(
      'empty-old-locator',
      `The persisted old locator for "${opts.slug}" is empty, so there is no safe emitted page locator to replace. ` +
        `Run \`${TOOL_NAME} triage ${opts.slug}\` or \`${TOOL_NAME} heal --results <results.json>\` again, then apply the new diagnosis manually.`,
    );
  }
  // Select and count fidelity patches first. A stability request then swaps
  // ONLY the selected value, so it never changes actionability classification,
  // multi-patch inputs, or any existing refusal/count wording.
  let stabilityDowngrade: SelectorApplyPreview['stabilityDowngrade'];
  if (opts.prefer === 'stability') {
    const candidate = patch.stabilityCandidate;
    if (candidate === undefined) {
      return refusal(
        'stability-candidate-unavailable',
        `Cannot apply a stability selector for "${opts.slug}": this persisted evidence has no recorded alternate that fresh traffic also verified. Run \`${TOOL_NAME} triage ${opts.slug}\` again after fresh traffic, or use the default fidelity patch.`,
      );
    }
    const winnerStrategy = classifyLocatorRung(patch.oldLocator);
    if (winnerStrategy === undefined) {
      return refusal(
        'stability-candidate-unavailable',
        `Cannot apply a stability selector for "${opts.slug}": the persisted recorded winner has no recognized selector rung. Use the default fidelity patch or repair the selector manually.`,
      );
    }
    // When the verified recorded alternate IS the fresh winner, the swap is a
    // value-identity no-op — applying it is correct, but announcing a
    // "downgrade" would be a false claim, so the notice stays silent.
    const isValueIdentity = candidate.locator === patch.freshLocator;
    patch = { ...patch, freshLocator: candidate.locator };
    if (!isValueIdentity) {
      stabilityDowngrade = { winnerStrategy, alternateStrategy: candidate.strategy };
    }
  }
  if (patch.freshLocator.length === 0 || patch.freshLocator === patch.oldLocator) {
    return refusal(
      'empty-fresh-locator',
      `The persisted fresh locator for "${opts.slug}" is not a usable replacement. ` +
        `Run \`${TOOL_NAME} triage ${opts.slug}\` or \`${TOOL_NAME} heal --results <results.json>\` again before changing this test.`,
    );
  }

  let anchoredLocator = patch.oldLocator;
  let occurrences = findAnchoredOccurrences(source, anchoredLocator);
  if (occurrences.length === 0 && evidence.failingLocator !== undefined) {
    anchoredLocator = evidence.failingLocator;
    occurrences = findAnchoredOccurrences(source, anchoredLocator);
  }
  // Location-only corroboration never changes which occurrence is
  // eventually selected/applied (an explicit `--occurrence` is still required
  // whenever more than one occurrence exists), only annotates the display so a
  // customer choosing a site has the step anchor's evidence to go on.
  occurrences = annotateOccurrencesWithAnchor(occurrences, evidence.patches, anchoredLocator, patch.stepIndex);

  if (opts.fromTriageVerdict === true) {
    // Opt-in verdict-apply mode. A hand-edit can delete the drifted OLD
    // locator string, so it can no longer be the sole anchor. We locate by the
    // diagnosed old locator when it survives, and otherwise reason about the
    // diagnosed FRESH locator the hand-edit may already hold. The optional
    // persisted step anchor (action/label/index) — when present it
    // can name (and, gated by a sanity check, LOCATE) the step's line even when
    // neither locator string appears, so a site hand-edited to a THIRD,
    // unrecognizable value gets an honest, more precise refusal below instead
    // of a generic one. Anchor-less evidence from before this optional field
    // gets the exact same message as before — this is a wording upgrade, never a new outcome.
    // Earlier classification already chose `patch`; this branch changes only location.
    const freshOccurrences = findAnchoredOccurrences(source, patch.freshLocator);
    if (occurrences.length === 0) {
      if (freshOccurrences.length > 0) {
        // The hand-edit already agrees with the verdict — no change is needed.
        return {
          kind: 'already-applied',
          slug: opts.slug,
          oldLocator: anchoredLocator,
          freshLocator: patch.freshLocator,
          specPath: paths.specDisplayPath,
          resolvedSpecPath: paths.resolvedSpecPath,
          specDisplayPath: paths.specDisplayPath,
          isDefaultSpecPath: paths.isDefaultSpecPath,
          occurrences: freshOccurrences,
        };
      }
      const located =
        patch.stepIndex !== undefined && patch.stepAction !== undefined
          ? locateStepLineByIndex(source, patch.stepIndex, patch.stepAction)
          : undefined;
      const foundClause =
        located === undefined
          ? ''
          : `Located the verdict's step (${patch.stepAction}${patch.stepLabel ? ` "${patch.stepLabel}"` : ''}, matched by step position) at line ${located.lineNumber} of ${paths.specDisplayPath}, currently \`${located.snippet}\`. `;
      return refusal(
        'verdict-site-unlocatable',
        `${foundClause}Cannot apply the triage verdict for "${opts.slug}" to ${paths.specDisplayPath}: neither the diagnosed old ` +
          `locator (\`${patch.oldLocator}\`)${evidence.failingLocator === undefined ? '' : ` nor the failing locator (\`${evidence.failingLocator}\`)`} ` +
          `nor the diagnosed fresh locator (\`${patch.freshLocator}\`) appears in the spec. The step this verdict describes ` +
          `was hand-edited to something this command cannot recognize; apply \`${patch.oldLocator} → ${patch.freshLocator}\` ` +
          `by hand at ${located === undefined ? 'the intended step' : `line ${located.lineNumber}`}, or restore the recorded locator first. Not guessing a site.`,
      );
    }
    if (freshOccurrences.length > 0 && opts.occurrence === undefined) {
      // Divergent: the drifted locator still sits at some site(s) AND the fresh
      // locator already sits elsewhere — a partial/inconsistent edit. Never
      // converge it silently; require an explicit numbered site pick.
      return refusal(
        'verdict-divergent',
        `The spec for "${opts.slug}" still holds the diagnosed old locator (\`${anchoredLocator}\`) at ${occurrences.length} ` +
          `site(s) AND already holds the diagnosed fresh locator (\`${patch.freshLocator}\`) at ${freshOccurrences.length} ` +
          `site(s) — a partial edit. Review the numbered old-locator site(s) below and run ` +
          `\`${TOOL_NAME} fix-selector ${opts.slug} --from-triage-verdict --apply --occurrence N\` to converge the intended one.`,
        occurrences,
      );
    }
    // Old locator still present and fresh absent (or an explicit --occurrence was
    // given for a divergent spec): fall through to the shared occurrence-picker +
    // apply flow below, which is byte-identical to the strict path from here on.
  } else if (occurrences.length === 0) {
    return refusal(
      'old-locator-absent',
      selectorRebuildAdvice(opts.slug, opts.handFinishedSlugs, `Neither the plan's diagnosed locator nor the failing locator is present in ${paths.specDisplayPath}. ` +
        `The spec has diverged from its plan; restore the recorded selector or run \`${TOOL_NAME} scaffold ${opts.slug} --force\` rather than forcing a selector patch.`,
      ),
    );
  }

  if (opts.occurrence !== undefined && (!Number.isInteger(opts.occurrence) || opts.occurrence < 1 || opts.occurrence > occurrences.length)) {
    return refusal(
      'occurrence-out-of-range',
      `Occurrence ${String(opts.occurrence)} is out of range for ${paths.specDisplayPath}; this patch has ${occurrences.length} occurrence(s). ` +
        `Choose a numbered occurrence below and run \`${TOOL_NAME} fix-selector ${opts.slug} --apply --occurrence N\`.`,
      occurrences,
    );
  }

  if (opts.apply === true && occurrences.length > 1 && opts.occurrence === undefined) {
    return refusal(
      'multiple-occurrences',
      `The diagnosed old locator appears ${occurrences.length} times in ${paths.specDisplayPath}; choosing automatically would be unsafe. ` +
        `Choose one numbered occurrence below and run \`${TOOL_NAME} fix-selector ${opts.slug} --apply --occurrence N\`.`,
      occurrences,
    );
  }

  const selectedOccurrence = opts.occurrence ?? (occurrences.length === 1 ? 1 : undefined);
  const preview: SelectorApplyPreview = {
    kind: 'preview',
    slug: opts.slug,
    oldLocator: anchoredLocator,
    freshLocator: patch.freshLocator,
    specPath: paths.specDisplayPath,
    resolvedSpecPath: paths.resolvedSpecPath,
    specDisplayPath: paths.specDisplayPath,
    isDefaultSpecPath: paths.isDefaultSpecPath,
    occurrences,
    ...(selectedOccurrence === undefined ? {} : { selectedOccurrence }),
    ...(shownInformational.length > 0 ? { informational: shownInformational } : {}),
    ...(stabilityDowngrade === undefined ? {} : { stabilityDowngrade }),
  };

  if (opts.apply !== true) return preview;

  // The multiple-occurrences guard above establishes this without guessing.
  if (selectedOccurrence === undefined) {
    return refusal(
      'occurrence-out-of-range',
      `No selected occurrence is available in ${paths.specDisplayPath}. Review the numbered occurrences and run this command again.`,
      occurrences,
    );
  }
  const selected = occurrences[selectedOccurrence - 1];
  if (selected === undefined) {
    return refusal(
      'occurrence-out-of-range',
      `No selected occurrence is available in ${paths.specDisplayPath}. Review the numbered occurrences and run this command again.`,
      occurrences,
    );
  }

  const oldAnchor = `page.${anchoredLocator}.`;
  const freshAnchor = `page.${patch.freshLocator}.`;
  const patched = `${source.slice(0, selected.offset)}${freshAnchor}${source.slice(selected.offset + oldAnchor.length)}`;
  const privacyDisclosure = buildPrivacyDisclosure([
    { path: 'PersistedSelectorPatch.priorLocator', value: anchoredLocator },
    { path: 'PersistedSelectorPatch.replacementLocator', value: patch.freshLocator },
  ]);
  if (privacyDisclosure !== undefined && opts.allowPrivacyDisclosure !== true) {
    return refusal('privacy-disclosure-required', PRIVACY_DISCLOSURE_REQUIRED_COPY, undefined, undefined, privacyDisclosure);
  }
  try {
    if (opts.stateLockHandle !== undefined) verifyStateLock(opts.stateLockHandle);
    const recovery = retirementRecoveryMessage(opts.slug, opts.retiredDir ?? path.join(paths.workspaceRoot, '.replaytest', 'retired'));
    if (recovery !== undefined) return refusal('retirement-recovery-required', recovery);
    emitArtifact('selector-patched-spec', paths.resolvedSpecPath, patched, {
      privacyDisclosure,
      allowPrivacyDisclosure: opts.allowPrivacyDisclosure,
    });
  } catch (err) {
    if (err instanceof StateLockFencedError) return refusal('state-lock-fenced', stateLockFencedMessage('fix-selector'));
    return refusal(
      'write-failed',
      `Could not apply the selector patch to ${paths.specDisplayPath} (${describeError(err)}). ` +
        `Check the file and apply the displayed patch manually.`,
    );
  }

  const appliedAt = (opts.now ?? (() => new Date()))().toISOString();
  const record: SelectorApplyRecord = {
    rowKind: 'selector-applies',
    canonicalSpecPath: paths.specDisplayPath.split(path.sep).join('/'),
    keyVersion: 1,
    slug: opts.slug,
    oldLocator: anchoredLocator,
    freshLocator: patch.freshLocator,
    specPath: paths.specDisplayPath,
    appliedAt,
    ...(privacyDisclosure === undefined || opts.allowPrivacyDisclosure !== true
      ? {}
      : {
          privacyOverride: {
            code: 'privacy-disclosure-required' as const,
            flag: '--allow-privacy-disclosure' as const,
            consentedAt: appliedAt,
            findings: privacyDisclosure.findings,
          },
        }),
  };
  const recordResult = appendRecord(paths.selectorAppliesPath, record, paths.selectorAppliesDisplayPath, opts.stateLockHandle, opts.publicationLedger);

  return {
    ...preview,
    kind: 'applied',
    selectedOccurrence,
    appliedAt,
    ...(recordResult.kind === 'recorded' ? { recordPath: paths.selectorAppliesDisplayPath } : { warning: recordResult.message }),
  };
  })();
  return withEvidenceNotice(result, evidence);
}

export function formatSelectorApplyResult(result: SelectorApplyResult): string {
  if (result.kind === 'refusal') {
    return [
      result.message,
      ...(result.evidenceNotice === undefined ? [] : [`Notice: ${result.evidenceNotice}`]),
      ...(result.occurrences === undefined ? [] : formatOccurrences(result.occurrences)),
      ...(result.informational === undefined ? [] : formatInformational(result.informational)),
    ].join('\n');
  }

  if (result.kind === 'already-applied') {
    return [
      `No selector patch needed for "${result.slug}": the spec already uses the diagnosed fresh locator.`,
      `  Spec: ${result.specPath}`,
      `  Verdict: ${result.oldLocator} → ${result.freshLocator} (already applied by a prior edit)`,
      ...(result.evidenceNotice === undefined ? [] : [`  Notice: ${result.evidenceNotice}`]),
      ...formatOccurrences(result.occurrences),
      'Already applied — no change needed.',
    ].join('\n');
  }

  const patch = [
    `${result.kind === 'applied' ? 'Applied selector patch' : 'Selector patch'} for "${result.slug}":`,
    `  Spec: ${result.specPath}`,
    `  Patch: ${result.oldLocator} → ${result.freshLocator}`,
    ...(result.stabilityDowngrade === undefined
      ? []
      : [`  Notice: applying a stabler-but-weaker selector rung by explicit request: ${result.stabilityDowngrade.winnerStrategy} → ${result.stabilityDowngrade.alternateStrategy}`]),
    ...(result.evidenceNotice === undefined ? [] : [`  Notice: ${result.evidenceNotice}`]),
    ...formatOccurrences(result.occurrences),
    ...(result.informational === undefined ? [] : formatInformational(result.informational)),
  ];

  if (result.kind === 'preview') {
    const command = result.occurrences.length > 1 && result.selectedOccurrence === undefined
      ? `${TOOL_NAME} fix-selector ${result.slug} --apply --occurrence N`
      : `${TOOL_NAME} fix-selector ${result.slug} --apply${
          result.occurrences.length > 1 && result.selectedOccurrence !== undefined
            ? ` --occurrence ${result.selectedOccurrence}`
            : ''
        }`;
    return [...patch, 'Dry run — no file was changed.', `Next: ${command}`].join('\n');
  }

  return [
    ...patch,
    `  Applied occurrence: ${result.selectedOccurrence}`,
    ...(result.recordPath === undefined ? [] : [`Recorded: ${result.recordPath}`]),
    ...(result.warning === undefined ? [] : [`Warning: ${result.warning}`]),
    'Next: re-run your tests.',
  ].join('\n');
}

function withEvidenceNotice(
  result: SelectorApplyResult,
  evidence: PersistedSelectorEvidence,
): SelectorApplyResult {
  if (evidence.evidenceNotice === undefined) return result;
  return { ...result, evidenceNotice: evidence.evidenceNotice };
}

function readPersistedEvidence(paths: ResolvedPaths, slug: string): PersistedSelectorEvidence | SelectorApplyRefusal {
  const candidates: PersistedSelectorEvidence[] = [];
  const invalidPaths: string[] = [];
  let refusedHealEvidence = false;

  const heal = readJson(paths.healLatestPath);
  if (heal.kind === 'invalid') {
    invalidPaths.push(paths.healLatestDisplayPath);
  } else if (heal.value !== undefined) {
    const lookup = patchesFromHealEnvelope(heal.value, slug, {
      expectedSpecPath: paths.resolvedSpecPath,
      workspaceRoot: paths.workspaceRoot,
    });
    if (lookup.kind === 'patches') {
      candidates.push({
        source: 'heal',
        displayPath: paths.healLatestDisplayPath,
        generatedAt: isRecord(heal.value) && typeof heal.value.generatedAt === 'string' ? heal.value.generatedAt : undefined,
        patches: lookup.patches,
        freshnessChecked: true,
      });
    } else if (lookup.kind === 'refused') {
      refusedHealEvidence = true;
    }
  }

  const triagePath = path.join(paths.triageEvidenceDir, `${slug}.json`);
  const triage = readJson(triagePath);
  if (triage.kind === 'invalid') {
    invalidPaths.push(paths.triageEvidenceDisplayPath);
  } else if (triage.value !== undefined) {
    const parsed = parsePersistedTriageEvidence(triage.value);
    if (parsed === undefined || parsed.slug !== slug) {
      invalidPaths.push(paths.triageEvidenceDisplayPath);
    } else {
      candidates.push(fromTriageEvidence(parsed, paths.triageEvidenceDisplayPath));
    }
  }

  if (candidates.length === 0) {
    if (invalidPaths.length > 0) {
      return refusal(
        'invalid-evidence',
        `Cannot trust persisted selector freshness evidence at ${invalidPaths.join(' or ')}. ` +
          `Re-run \`${TOOL_NAME} triage ${slug}\` before trying again.`,
      );
    }
    if (refusedHealEvidence) {
      const relocationClause = paths.isDefaultSpecPath
        ? ''
        : ` The spec moved to ${paths.specDisplayPath}, but the recorded evidence still names another path.`;
      return refusal(
        'missing-evidence',
        `${EVIDENCE_PATH_REFUSAL_MESSAGE}${relocationClause} Re-run \`${TOOL_NAME} heal --results <results.json>\` before trying this selector patch again.`,
      );
    }
    return refusal(
      'missing-evidence',
      `No persisted selector freshness evidence found for "${slug}" in ${paths.triageEvidenceDisplayPath} or ${paths.healLatestDisplayPath}. ` +
        `Run \`${TOOL_NAME} triage ${slug}\` or \`${TOOL_NAME} heal --results <results.json>\` first, then try again.`,
    );
  }

  // Triage and heal are independent writers. Timestamp decides precedence;
  // an exact tie goes to direct single-slug triage because it is the more
  // specific customer action and preserves an explicit empty change-set.
  const selected = candidates.sort((left, right) => {
    const byTime = timestampMs(right.generatedAt) - timestampMs(left.generatedAt);
    if (byTime !== 0) return byTime;
    return left.source === right.source ? 0 : left.source === 'triage' ? -1 : 1;
  })[0] as PersistedSelectorEvidence;
  return refusedHealEvidence && selected.source === 'triage'
    ? {
        ...selected,
        evidenceNotice: `${EVIDENCE_PATH_REFUSAL_MESSAGE} A separate triage record supplies the selector evidence used here.`,
      }
    : selected;
}

function fromTriageEvidence(evidence: PersistedTriageEvidence, displayPath: string): PersistedSelectorEvidence {
  return {
    source: 'triage',
    displayPath,
    generatedAt: evidence.generatedAt,
    patches: evidence.selectorFreshness.changed.map((change) => ({
      oldLocator: change.oldLocator,
      freshLocator: change.freshLocator,
      ...(change.basis === undefined ? {} : { basis: change.basis }),
      ...(change.stabilityCandidate === undefined ? {} : { stabilityCandidate: change.stabilityCandidate }),
      // Carry the persisted step anchor through unchanged; it is absent on
      // evidence written before this optional field existed.
      ...(change.stepAction === undefined ? {} : { stepAction: change.stepAction }),
      ...(change.stepLabel === undefined ? {} : { stepLabel: change.stepLabel }),
      ...(change.stepIndex === undefined ? {} : { stepIndex: change.stepIndex }),
    })),
    freshnessChecked: evidence.selectorFreshness.checked,
    ...(evidence.failingLocator === undefined ? {} : { failingLocator: evidence.failingLocator }),
  };
}

function readJson(file: string): { kind: 'missing'; value?: undefined } | { kind: 'invalid' } | { kind: 'read'; value: unknown } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return isMissingFileError(err) ? { kind: 'missing' } : { kind: 'invalid' };
  }
  try {
    return { kind: 'read', value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: 'invalid' };
  }
}

function staleEvidenceReason(evidence: PersistedSelectorEvidence, paths: ResolvedPaths, specPath: string): string | undefined {
  const generatedAtMs = timestampMs(evidence.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return `it has no valid generatedAt timestamp (${evidence.displayPath})`;
  try {
    const mtimeMs = fs.statSync(specPath).mtimeMs;
    if (generatedAtMs < mtimeMs) return `it predates ${paths.specDisplayPath}'s mtime`;
  } catch {
    // The source read above already succeeded; an intervening stat failure is
    // handled by the normal safe local write guard below.
  }
  const latestRun = readLatestRecordedRun(paths.lastRunStatePath, paths.reporterLastRunPath);
  return latestRun !== undefined && generatedAtMs < timestampMs(latestRun.runStartedAt) ? `it predates the latest recorded test run (${latestRun.runStartedAt})` : undefined;
}

function appendRecord(
  selectorAppliesPath: string,
  record: SelectorApplyRecord,
  displayPath: string,
  stateLockHandle?: StateLockHandle,
  publicationLedger?: StatePublicationLedger,
): { kind: 'recorded' } | { kind: 'not-recorded'; message: string } {
  let records: unknown[] = [];
  if (fs.existsSync(selectorAppliesPath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(selectorAppliesPath, 'utf8');
    } catch (err) {
      return {
        kind: 'not-recorded',
        message: `The patch was applied, but no bookkeeping record was written to ${displayPath} because the existing file could not be read (${describeError(err)}).`,
      };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return {
          kind: 'not-recorded',
          message: `The patch was applied, but no bookkeeping record was written to ${displayPath} because it is not a JSON array. Repair that file before the next apply.`,
        };
      }
      records = parsed;
    } catch (err) {
      return {
        kind: 'not-recorded',
        message: `The patch was applied, but no bookkeeping record was written to ${displayPath} because it has invalid JSON (${describeError(err)}). Repair that file before the next apply.`,
      };
    }
  }
  try {
    fs.mkdirSync(path.dirname(selectorAppliesPath), { recursive: true });
    writeStateFile('selector-apply-record', selectorAppliesPath, `${JSON.stringify([...records, record], null, 2)}\n`, { stateLockHandle, publicationLedger });
    return { kind: 'recorded' };
  } catch (err) {
    return {
      kind: 'not-recorded',
      message: `The patch was applied, but no bookkeeping record was written to ${displayPath} (${describeError(err)}). Record this change manually and re-run your tests.`,
    };
  }
}

function resolvePaths(opts: SelectorApplyOptions): ResolvedPaths | SelectorApplyRefusal {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const generatedTestsDir = opts.generatedTestsDir ?? path.join(workspaceRoot, 'tests', 'generated');
  const healLatestPath = opts.healLatestPath ?? path.join(workspaceRoot, '.replaytest', 'state', 'heal-latest.json');
  const triageEvidenceDir = opts.triageEvidenceDir ?? path.join(workspaceRoot, '.replaytest', 'state', 'triage-latest');
  const lastRunStatePath = opts.lastRunStatePath ?? path.join(workspaceRoot, '.replaytest', 'state', 'last-run.json');
  const reporterLastRunPath = opts.reporterLastRunPath ?? path.join(workspaceRoot, '.replaytest', 'last-run.json');
  const selectorAppliesPath = opts.selectorAppliesPath ?? path.join(workspaceRoot, '.replaytest', 'state', 'selector-applies.json');
  const defaultSpecPath = path.join(generatedTestsDir, `${opts.slug}.spec.ts`);
  let resolvedSpecPath = defaultSpecPath;
  let isDefaultSpecPath = true;
  if (!fs.existsSync(defaultSpecPath)) {
    const progress = opts.progress ?? (() => {});
    progress(`Scanning generated specs for a relocated ${opts.slug} (budget: ${SUITE_SCAN_MAX_FILES} files)…`);
    const scan = (opts.collectGeneratedSpecHeaders ?? collectGeneratedSpecHeaders)(
      generatedTestsDir,
      workspaceRoot,
      undefined,
      { maxFiles: SUITE_SCAN_MAX_FILES, maxDirectories: SUITE_SCAN_MAX_DIRECTORIES },
    );
    if (scan.capped) {
      const message = `Cannot repair "${opts.slug}": the relocated-spec scan stopped at the suite-scan budget (${scan.cappedBy ?? 'unknown'}) without a decision. Pass the spec path explicitly or restore it to the default path.`;
      progress(message);
      return refusal('fix-selector-spec-scan-capped', message);
    }
    const matchingPaths = scan.pathsBySlug.get(opts.slug) ?? [];
    if (matchingPaths.length > 1) {
      const listedPaths = formatRelocatedSpecPaths(matchingPaths, workspaceRoot);
      const message = `Cannot repair "${opts.slug}": ${matchingPaths.length} generated specs carry its slug header: ${listedPaths.slice(0, 2).join(', ')}. Pass the spec path explicitly or restore exactly one copy to the default path.`;
      progress(message);
      return refusal('fix-selector-spec-ambiguous', message);
    }
    const relocated = scan.headers.get(opts.slug);
    if (relocated !== undefined) {
      resolvedSpecPath = path.resolve(workspaceRoot, relocated);
      isDefaultSpecPath = false;
      progress(`Relocated spec found at ${toPortableWorkspaceDisplayPath(resolvedSpecPath, workspaceRoot)}.`);
    } else {
      progress(`No relocated spec carrying the ${opts.slug} slug header was found.`);
    }
  }
  const specDisplayPath = toPortableWorkspaceDisplayPath(resolvedSpecPath, workspaceRoot);
  return {
    workspaceRoot,
    resolvedSpecPath,
    specDisplayPath,
    isDefaultSpecPath,
    healLatestPath,
    healLatestDisplayPath: toDisplayPath(healLatestPath, workspaceRoot),
    triageEvidenceDir,
    triageEvidenceDisplayPath: toDisplayPath(path.join(triageEvidenceDir, `${opts.slug}.json`), workspaceRoot),
    lastRunStatePath,
    reporterLastRunPath,
    selectorAppliesPath,
    selectorAppliesDisplayPath: toDisplayPath(selectorAppliesPath, workspaceRoot),
  };
}

function formatOccurrences(occurrences: readonly SelectorOccurrence[]): string[] {
  return [
    `  Occurrences (${occurrences.length}):`,
    ...occurrences.map(
      (occurrence) =>
        // Display-only corroboration — never implies this occurrence was
        // selected/applied; an explicit --occurrence is still required.
        `  ${occurrence.number}. \`${occurrence.snippet}\`${occurrence.anchorMatch === true ? ' (anchor match — likely the verdict\'s step)' : ''}`,
    ),
  ];
}

/** Renders the filtered noise patches honestly so nothing is silently dropped. */
function formatInformational(informational: readonly InformationalPatch[]): string[] {
  return [
    `  Informational — shown, not proposed (${informational.length}):`,
    ...informational.map((entry) => `  - ${entry.oldLocator} → ${entry.freshLocator} (${entry.reason})`),
  ];
}

function sourceLineAt(source: string, offset: number): string {
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  const end = source.indexOf('\n', offset);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

function refusal(
  code: SelectorApplyRefusalCode,
  message: string,
  occurrences?: SelectorOccurrence[],
  informational?: InformationalPatch[],
  privacyDisclosure?: PrivacyDisclosure,
): SelectorApplyRefusal {
  return {
    kind: 'refusal',
    code,
    message,
    exitCode: 1,
    ...(occurrences === undefined ? {} : { occurrences }),
    ...(informational === undefined ? {} : { informational }),
    ...(privacyDisclosure === undefined ? {} : { privacyDisclosure }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStabilityCandidate(value: unknown): value is { strategy: string; locator: string } {
  return isRecord(value) && typeof value.strategy === 'string' && typeof value.locator === 'string';
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toDisplayPath(filename: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filename);
  return relative.startsWith('..') || path.isAbsolute(relative) ? filename : relative;
}

interface PathDisplayApi {
  basename(filename: string): string;
  isAbsolute(filename: string): boolean;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

/** Formats a workspace path for stable customer display on POSIX and Windows. */
export function toPortableWorkspaceDisplayPath(
  filename: string,
  workspaceRoot: string,
  pathApi: PathDisplayApi = path,
): string {
  const relative = pathApi.relative(workspaceRoot, filename);
  const display = relative === ''
    ? pathApi.basename(filename)
    : relative.startsWith('..') || pathApi.isAbsolute(relative)
      ? filename
      : relative;
  return display.split(pathApi.sep).join('/');
}

/** Sorts relocated candidates after applying the same workspace-relative display rule. */
export function formatRelocatedSpecPaths(
  candidatePaths: readonly string[],
  workspaceRoot: string,
  pathApi: PathDisplayApi = path,
): string[] {
  return candidatePaths
    .map((candidate) => toPortableWorkspaceDisplayPath(
      pathApi.isAbsolute(candidate) ? candidate : pathApi.resolve(workspaceRoot, candidate),
      workspaceRoot,
      pathApi,
    ))
    .sort();
}
