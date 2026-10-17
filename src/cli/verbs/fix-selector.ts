import * as fs from 'node:fs';
import * as path from 'node:path';
import { emitArtifact } from '../../artifact-registry.js';
import { renderPlanMarkdown, type Sidecar, type SidecarLocatorRepair } from '../../sidecar.js';
import { parseSidecarJson } from '../../triage.js';
import { applyPersistedSelectorPatch, formatSelectorApplyResult, locateStepLineByIndex, selectorPatchesFromHealEnvelope, type SelectorApplyResult } from '../../selector-apply.js';
import { parsePersistedTriageEvidence } from '../../triage-evidence.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, emitUsageError, parseFixSelectorArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { DEFAULT_HEAL_RESULTS_PATH, GENERATED_TESTS_DIR, HEAL_LAST_RUN_STATE_PATH, HEAL_LATEST_PATH, SELECTOR_APPLIES_PATH, SPEC_EMITTED_HASHES_PATH, TRIAGE_EVIDENCE_DIR, WORKSPACE_ROOT } from '../paths.js';
import { describeIoError, isMissingFileError } from '../errors.js';
import { formatTerminalTimestamps } from '../terminal-format.js';
import { hashSpecContent } from '../../heal-run-hashes.js';
import { refreshPlanAxisAfterAlreadyApplied, stampEmittedSpecHash, type ConfirmedFix } from '../../spec-emitted-hashes.js';
import { buildHandFinishedRegistryRefusal, isHandFinishedRegistryInvalid, readHandFinishedRegistry } from '../../hand-finished.js';
import { acquireStateLock, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, type StateLockHandle } from '../../state-lock.js';
import { createStatePublicationLedger, makeStateArtifactWriter, releaseStateLockWithDisclosure } from '../../state-writes.js';
import { retirementRecoveryMessage } from '../retired-awareness.js';
import type { ArtifactPrivacyOptions } from '../../artifact-registry.js';
import { buildPrivacyDisclosure } from '../../pii-lint.js';

// ---------------------------------------------------------------------------
// fix-selector — exact one-occurrence repair from persisted heal evidence.
// ---------------------------------------------------------------------------

export interface FixSelectorRunDeps {
  workspaceRoot?: string;
  generatedTestsDir?: string;
  healLatestPath?: string;
  triageEvidenceDir?: string;
  lastRunStatePath?: string;
  reporterLastRunPath?: string;
  selectorAppliesPath?: string;
  specEmittedHashesPath?: string;
  /** Test seam for the two registered plan projection writes. */
  planArtifactWriter?: PlanArtifactWriter;
  now?: () => Date;
  handFinishedSlugs?: ReadonlySet<string>;
  log?: (line: string) => void;
  progress?: (line: string) => void;
  /** Test seams for proving that relocated specs never enter default-path-keyed state. */
  stampEmittedSpecHash?: typeof stampEmittedSpecHash;
  refreshPlanAxisAfterAlreadyApplied?: typeof refreshPlanAxisAfterAlreadyApplied;
}

type PlanArtifactWriter = (artifactClass: 'plan-json' | 'plan-md', targetPath: string, content: string, options?: ArtifactPrivacyOptions) => void;

function resolveFixSelectorRunDeps(deps: FixSelectorRunDeps): Required<
  Pick<FixSelectorRunDeps, 'workspaceRoot' | 'generatedTestsDir' | 'healLatestPath' | 'triageEvidenceDir' | 'lastRunStatePath' | 'reporterLastRunPath' | 'selectorAppliesPath' | 'specEmittedHashesPath' | 'planArtifactWriter' | 'log' | 'progress' | 'handFinishedSlugs' | 'stampEmittedSpecHash' | 'refreshPlanAxisAfterAlreadyApplied'>
> & Pick<FixSelectorRunDeps, 'now'> & { handFinishedRegistryError?: string } {
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const registry = deps.handFinishedSlugs === undefined ? readHandFinishedRegistry(workspaceRoot) : { slugs: deps.handFinishedSlugs, entries: [] };
  return {
    workspaceRoot,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    healLatestPath: deps.healLatestPath ?? HEAL_LATEST_PATH,
    triageEvidenceDir: deps.triageEvidenceDir ?? TRIAGE_EVIDENCE_DIR,
    lastRunStatePath: deps.lastRunStatePath ?? HEAL_LAST_RUN_STATE_PATH,
    reporterLastRunPath: deps.reporterLastRunPath ?? DEFAULT_HEAL_RESULTS_PATH,
    selectorAppliesPath: deps.selectorAppliesPath ?? SELECTOR_APPLIES_PATH,
    specEmittedHashesPath: deps.specEmittedHashesPath ?? SPEC_EMITTED_HASHES_PATH,
    planArtifactWriter: deps.planArtifactWriter ?? emitArtifact,
    log: deps.log ?? ((line: string) => console.log(line)),
    progress: deps.progress ?? ((line: string) => console.error(line)),
    stampEmittedSpecHash: deps.stampEmittedSpecHash ?? stampEmittedSpecHash,
    refreshPlanAxisAfterAlreadyApplied: deps.refreshPlanAxisAfterAlreadyApplied ?? refreshPlanAxisAfterAlreadyApplied,
    handFinishedSlugs: isHandFinishedRegistryInvalid(registry) ? new Set<string>() : registry.slugs,
    ...(isHandFinishedRegistryInvalid(registry) ? { handFinishedRegistryError: registry.error } : {}),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}

interface SelectorEvidencePatch {
  oldLocator: string;
  freshLocator: string;
  stabilityCandidate?: { strategy: string; locator: string };
  stepAction?: 'fill' | 'click';
  stepIndex?: number;
}

interface SelectorEvidenceCandidate {
  source: 'heal' | 'triage';
  generatedAt?: string;
  freshnessChecked: boolean;
  patches: SelectorEvidencePatch[];
}

type ConfirmedFixResolution =
  | { kind: 'confirmed'; fix: ConfirmedFix }
  | { kind: 'refused'; reason: string };

interface VerifiedRecordedAlternate {
  strategy: string;
  locator: string;
}

/** A narrow parse for additive repair history: malformed local history is never overwritten. */
function isLocatorRepairHistory(value: unknown): value is SidecarLocatorRepair[] {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const repair = entry as Partial<SidecarLocatorRepair>;
    return (
      typeof repair.appliedAt === 'string' &&
      repair.reason === 'fix-selector: persisted selector freshness repair' &&
      typeof repair.stepIndex === 'number' &&
      Number.isInteger(repair.stepIndex) &&
      repair.stepIndex >= 0 &&
      typeof repair.priorLocator === 'string' &&
      typeof repair.replacementLocator === 'string' &&
      typeof repair.specPath === 'string'
    );
  });
}

function readJsonForSelectorRepair(filename: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Mirrors selector-apply's timestamp precedence without importing its private reader. */
function repairEvidenceTimestamp(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Reads the same newest persisted evidence source that fix-selector consumes,
 * but only to DISPLAY a recorded alternate. It never supplies an apply value.
 */
function selectorEvidenceForRepairDisplay(
  slug: string,
  healLatestPath: string,
  triageEvidenceDir: string,
): SelectorEvidenceCandidate | undefined {
  const candidates: SelectorEvidenceCandidate[] = [];
  const heal = readJsonForSelectorRepair(healLatestPath);
  if (heal !== undefined) {
    const patches = selectorPatchesFromHealEnvelope(heal, slug);
    if (patches !== undefined) {
      candidates.push({
        source: 'heal',
        generatedAt: typeof heal === 'object' && heal !== null && typeof (heal as { generatedAt?: unknown }).generatedAt === 'string'
          ? (heal as { generatedAt: string }).generatedAt
          : undefined,
        freshnessChecked: true,
        patches,
      });
    }
  }

  const triage = readJsonForSelectorRepair(path.join(triageEvidenceDir, `${slug}.json`));
  const parsedTriage = triage === undefined ? undefined : parsePersistedTriageEvidence(triage);
  if (parsedTriage?.slug === slug) {
    candidates.push({
      source: 'triage',
      generatedAt: parsedTriage.generatedAt,
      freshnessChecked: parsedTriage.selectorFreshness.checked,
      patches: parsedTriage.selectorFreshness.changed,
    });
  }

  return candidates.sort((left, right) => {
    const byTime = repairEvidenceTimestamp(right.generatedAt) - repairEvidenceTimestamp(left.generatedAt);
    if (byTime !== 0) return byTime;
    return left.source === right.source ? 0 : left.source === 'triage' ? -1 : 1;
  })[0];
}

/**
 * A stability candidate is shown only when all three independent witnesses
 * agree: the selected fresh evidence validated it, the persisted plan still
 * carries that alternate, and there is exactly one recorded plan step to name.
 * Any ambiguity omits the option rather than inventing selector provenance.
 */
function verifiedRecordedAlternateForSelectorRepair(
  slug: string,
  oldLocator: string,
  freshLocator: string,
  workspaceRoot: string,
  healLatestPath: string,
  triageEvidenceDir: string,
): VerifiedRecordedAlternate | undefined {
  const evidence = selectorEvidenceForRepairDisplay(slug, healLatestPath, triageEvidenceDir);
  if (evidence?.freshnessChecked !== true) return undefined;
  const matchingPatches = evidence.patches.filter((patch) =>
    patch.oldLocator === oldLocator &&
    (patch.freshLocator === freshLocator || patch.stabilityCandidate?.locator === freshLocator) &&
    patch.stabilityCandidate !== undefined,
  );
  if (matchingPatches.length !== 1) return undefined;
  const candidate = matchingPatches[0]?.stabilityCandidate;
  if (candidate === undefined) return undefined;

  const rawPlan = readJsonForSelectorRepair(path.join(workspaceRoot, '.replaytest', 'plans', `${slug}.plan.json`));
  if (rawPlan === undefined) return undefined;
  const parsedPlan = parseSidecarJson(JSON.stringify(rawPlan));
  if (parsedPlan.kind !== 'sidecar') return undefined;
  const matchingSteps = parsedPlan.sidecar.steps.filter((step) => step.locator === oldLocator);
  if (matchingSteps.length !== 1) return undefined;
  const alternates = matchingSteps[0]?.selectorAlternates;
  if (!Array.isArray(alternates) || !alternates.some((alternate) =>
    alternate.strategy === candidate.strategy && alternate.locator === candidate.locator,
  )) return undefined;
  return candidate;
}

function formatRecordedAlternateOption(alternate: VerifiedRecordedAlternate): string {
  return [
    `  Recorded alternate (optional): ${alternate.locator}`,
    '  Trade-off: the default literal follows fresh traffic; this alternate favors fidelity to the original recording and may offer churn-resilience. Apply it only with `--prefer stability`.',
  ].join('\n');
}

function repairPlanDisplayPath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? absolutePath : relative;
}

function planSyncWarning(
  specPath: string,
  jsonPath: string,
  markdownPath: string,
  oldLocator: string,
  detail: string,
): string {
  return [
    `WARNING: plan sidecar was not synchronized after repairing ${specPath}.`,
    `${jsonPath} and ${markdownPath} were left unchanged and still refer to ${oldLocator}: ${detail}.`,
    `Run \`${TOOL_NAME} triage <slug>\` to review the persisted evidence, then update the named plan step deliberately; do not regenerate the full plan just to clear this warning.`,
  ].join(' ');
}

function partialPlanSyncWarning(
  specPath: string,
  jsonPath: string,
  markdownPath: string,
  oldLocator: string,
  freshLocator: string,
  detail: string,
): string {
  return [
    `WARNING: plan sidecar was only partially synchronized after repairing ${specPath}.`,
    `${jsonPath} was updated to ${freshLocator} and records locator-repair provenance.`,
    `${markdownPath} was not updated and still refers to ${oldLocator}: ${detail}`,
    `Inspect both named files before continuing; do not regenerate the full plan just to clear this warning.`,
  ].join(' ');
}

function planMirrorRecoveryWarning(
  specPath: string,
  jsonPath: string,
  markdownPath: string,
  oldLocator: string,
  freshLocator: string,
  detail: string,
): string {
  return [
    `WARNING: plan Markdown mirror was not synchronized after repairing ${specPath}.`,
    `${jsonPath} already records ${oldLocator} → ${freshLocator}; ${markdownPath} differs from that JSON projection and was left unchanged: ${detail}.`,
    `Inspect both named files before continuing; do not regenerate the full plan just to clear this warning.`,
  ].join(' ');
}

interface SelectorPlanRepairTarget {
  oldLocator: string;
  stepAction?: 'fill' | 'click';
  stepIndex?: number;
}

/**
 * The spec can be anchored on a separate diagnosed failing locator, while the
 * plan remains anchored on the selector freshness patch's recorded locator.
 * Re-read the same newest local evidence only to identify that plan field;
 * ambiguity takes the existing warning path rather than guessing.
 */
function selectorPlanRepairTarget(
  result: { slug: string; oldLocator: string; freshLocator: string },
  healLatestPath: string,
  triageEvidenceDir: string,
): SelectorPlanRepairTarget | undefined {
  const evidence = selectorEvidenceForRepairDisplay(result.slug, healLatestPath, triageEvidenceDir);
  if (evidence === undefined) return { oldLocator: result.oldLocator };

  const matchingFresh = evidence.patches.filter((patch) =>
    patch.freshLocator === result.freshLocator || patch.stabilityCandidate?.locator === result.freshLocator,
  );
  const matchingAnchor = matchingFresh.filter((patch) => patch.oldLocator === result.oldLocator);
  const patch = matchingAnchor.length === 1
    ? matchingAnchor[0]
    : matchingFresh.length === 1
      ? matchingFresh[0]
      : undefined;
  if (patch === undefined) return undefined;
  return {
    oldLocator: patch.oldLocator,
    ...(patch.stepAction === undefined ? {} : { stepAction: patch.stepAction }),
    ...(patch.stepIndex === undefined ? {} : { stepIndex: patch.stepIndex }),
  };
}

/**
 * The already-applied leg can record only a scoped fact, never a whole-file
 * authorship claim. Require the exact single occurrence to be the production
 * action line located by the persisted step anchor; comments and strings are
 * deliberately not eligible fingerprint sites.
 */
function confirmedFixForAlreadyApplied(
  source: string,
  result: { freshLocator: string; occurrences: readonly { offset: number; snippet: string }[] },
  target: SelectorPlanRepairTarget,
  confirmedAt: string,
): ConfirmedFixResolution {
  if (result.occurrences.length > 1) {
    return { kind: 'refused', reason: `${result.occurrences.length} ambiguous sites` };
  }
  if (result.occurrences.length === 0) return { kind: 'refused', reason: 'the fresh locator was not found in the spec' };
  const occurrence = result.occurrences[0];
  if (occurrence === undefined) return { kind: 'refused', reason: 'the fresh locator was not found in the spec' };
  const occurrenceLine = occurrence.snippet.trim();
  if (occurrenceLine.startsWith('//')) return { kind: 'refused', reason: 'the matched line is a comment, not an action step' };
  if (!occurrenceLine.startsWith('await page.') && !occurrenceLine.startsWith('.') && /['"`]/.test(occurrenceLine)) {
    return { kind: 'refused', reason: 'the matched line is a string, not an action step' };
  }
  if (target.stepIndex === undefined) return { kind: 'refused', reason: 'the diagnosed step has no step anchor' };
  const located = target.stepAction === undefined
    ? locateStepLineByIndex(source, target.stepIndex, 'fill') ?? locateStepLineByIndex(source, target.stepIndex, 'click')
    : locateStepLineByIndex(source, target.stepIndex, target.stepAction);
  if (located === undefined) return { kind: 'refused', reason: 'the diagnosed step could not be located as an action line' };
  const trimmed = located.snippet.trim();
  const prefix = `await page.${result.freshLocator}.`;
  if (!trimmed.startsWith(prefix) || !/\.(?:fill|click|selectOption|check)\(/.test(trimmed.slice('await page.'.length))) {
    return { kind: 'refused', reason: 'the diagnosed step is not the fresh-locator action line' };
  }
  if (occurrence.snippet.trim() !== located.snippet) {
    return { kind: 'refused', reason: 'the matched line does not match the diagnosed action line' };
  }
  return {
    kind: 'confirmed',
    fix: {
      anchor: result.freshLocator,
      stepIndex: target.stepIndex,
      offset: occurrence.offset,
      lineHash: hashSpecContent(located.snippet),
      confirmedAt,
    },
  };
}

/**
 * Synchronously advances the reviewed plan after selector-apply has repaired
 * the owned emitted spec. This is deliberately a one-step field change,
 * never a session re-plan: ambiguous/malformed local data takes the warning
 * path so a full-regeneration clobber stays impossible here.
 */
function synchronizePlanAfterSelectorRepair(
  result: { slug: string; oldLocator: string; freshLocator: string; specPath: string; appliedAt: string },
  workspaceRoot: string,
  target: SelectorPlanRepairTarget,
  writeArtifact: PlanArtifactWriter,
  allowPrivacyDisclosure = false,
): { kind: 'synchronized' | 'already-synchronized'; message: string; sidecar: Sidecar } | { kind: 'warning'; message: string } {
  const absoluteJsonPath = path.join(workspaceRoot, '.replaytest', 'plans', `${result.slug}.plan.json`);
  const absoluteMarkdownPath = path.join(workspaceRoot, '.replaytest', 'plans', `${result.slug}.md`);
  const jsonPath = repairPlanDisplayPath(workspaceRoot, absoluteJsonPath);
  const markdownPath = repairPlanDisplayPath(workspaceRoot, absoluteMarkdownPath);
  let raw: string;
  try {
    raw = fs.readFileSync(absoluteJsonPath, 'utf8');
  } catch (error) {
    return {
      kind: 'warning',
      message: planSyncWarning(result.specPath, jsonPath, markdownPath, target.oldLocator, `the JSON sidecar could not be read (${describeIoError(error)})`),
    };
  }

  const parsed = parseSidecarJson(raw);
  if (parsed.kind !== 'sidecar') {
    return {
      kind: 'warning',
      message: planSyncWarning(result.specPath, jsonPath, markdownPath, target.oldLocator, `the JSON sidecar is invalid (${parsed.reason})`),
    };
  }

  const rawHistory = parsed.sidecar.source.locatorRepairs as unknown;
  if (rawHistory !== undefined && !isLocatorRepairHistory(rawHistory)) {
    return {
      kind: 'warning',
      message: planSyncWarning(
        result.specPath,
        jsonPath,
        markdownPath,
        target.oldLocator,
        'the existing source.locatorRepairs provenance is malformed and was left untouched',
      ),
    };
  }

  const matchingIndexes = target.stepIndex === undefined
    ? parsed.sidecar.steps.flatMap((step, index) => step.locator === target.oldLocator ? [index] : [])
    : parsed.sidecar.steps[target.stepIndex]?.locator === target.oldLocator
      ? [target.stepIndex]
      : [];
  const targetAlreadyCarriesReplacement = target.stepIndex !== undefined &&
    parsed.sidecar.steps[target.stepIndex]?.locator === result.freshLocator;
  const matchingRecordedRepairs = (rawHistory ?? []).filter((repair) =>
    repair.priorLocator === target.oldLocator &&
    repair.replacementLocator === result.freshLocator &&
    (target.stepIndex === undefined || repair.stepIndex === target.stepIndex) &&
    parsed.sidecar.steps[repair.stepIndex]?.locator === result.freshLocator,
  );
  if (matchingIndexes.length === 0 && (targetAlreadyCarriesReplacement || matchingRecordedRepairs.length > 0)) {
    const expectedMarkdown = `${renderPlanMarkdown(parsed.sidecar)}\n`;
    let actualMarkdown: string | undefined;
    let markdownMissing = false;
    try {
      actualMarkdown = fs.readFileSync(absoluteMarkdownPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) markdownMissing = true;
      else {
        return {
          kind: 'warning',
          message: planMirrorRecoveryWarning(
            result.specPath,
            jsonPath,
            markdownPath,
            target.oldLocator,
            result.freshLocator,
            `the Markdown mirror could not be read (${describeIoError(error)})`,
          ),
        };
      }
    }
    if (actualMarkdown === expectedMarkdown) {
      return {
        kind: 'already-synchronized',
        message: `Plan already synchronized: ${jsonPath} + ${markdownPath} already record ${target.oldLocator} → ${result.freshLocator}.`,
        sidecar: parsed.sidecar,
      };
    }

    const repairForRecovery = matchingRecordedRepairs[0];
    const expectedPreRepairMarkdown = repairForRecovery === undefined
      ? undefined
      : `${renderPlanMarkdown({
          ...parsed.sidecar,
          source: {
            ...parsed.sidecar.source,
            locatorRepairs: (rawHistory ?? []).filter((repair) => repair !== repairForRecovery),
          },
          steps: parsed.sidecar.steps.map((step, index) =>
            index === repairForRecovery.stepIndex ? { ...step, locator: repairForRecovery.priorLocator } : step,
          ),
        })}\n`;
    if (markdownMissing || actualMarkdown === expectedPreRepairMarkdown) {
      try {
        writeArtifact('plan-md', absoluteMarkdownPath, expectedMarkdown);
      } catch (error) {
        return {
          kind: 'warning',
          message: planMirrorRecoveryWarning(
            result.specPath,
            jsonPath,
            markdownPath,
            target.oldLocator,
            result.freshLocator,
            `the Markdown projection could not be written (${describeIoError(error)})`,
          ),
        };
      }
      return {
        kind: 'synchronized',
        message: `Plan Markdown mirror synchronized: ${jsonPath} already recorded the repair; ${markdownPath} was re-rendered from it.`,
        sidecar: parsed.sidecar,
      };
    }
    return {
      kind: 'warning',
      message: planMirrorRecoveryWarning(
        result.specPath,
        jsonPath,
        markdownPath,
        target.oldLocator,
        result.freshLocator,
        'the Markdown mirror differs from the JSON sidecar render and may contain hand edits',
      ),
    };
  }
  if (matchingIndexes.length !== 1) {
    return {
      kind: 'warning',
      message: planSyncWarning(
        result.specPath,
        jsonPath,
        markdownPath,
        target.oldLocator,
        `${matchingIndexes.length} recorded actions still refer to ${target.oldLocator}; a surgical field update needs exactly one`,
      ),
    };
  }

  const stepIndex = matchingIndexes[0] as number;
  let originalMarkdown: string;
  try {
    originalMarkdown = fs.readFileSync(absoluteMarkdownPath, 'utf8');
  } catch (error) {
    return {
      kind: 'warning',
      message: planSyncWarning(
        result.specPath,
        jsonPath,
        markdownPath,
        target.oldLocator,
        `the Markdown mirror could not be read (${describeIoError(error)})`,
      ),
    };
  }
  const expectedOriginalMarkdown = `${renderPlanMarkdown(parsed.sidecar)}\n`;
  if (originalMarkdown !== expectedOriginalMarkdown) {
    return {
      kind: 'warning',
      message: planSyncWarning(
        result.specPath,
        jsonPath,
        markdownPath,
        target.oldLocator,
        'the Markdown mirror differs from the pre-repair sidecar render and may contain hand edits',
      ),
    };
  }

  const repair: SidecarLocatorRepair = {
    appliedAt: result.appliedAt,
    reason: 'fix-selector: persisted selector freshness repair',
    stepIndex,
    priorLocator: target.oldLocator,
    replacementLocator: result.freshLocator,
    specPath: result.specPath,
  };
  const sidecar: Sidecar = {
    ...parsed.sidecar,
    source: { ...parsed.sidecar.source, locatorRepairs: [...(rawHistory ?? []), repair] },
    steps: parsed.sidecar.steps.map((step, index) => index === stepIndex ? { ...step, locator: result.freshLocator } : step),
  };
  const repairPrivacyDisclosure = buildPrivacyDisclosure([
    { path: 'SidecarLocatorRepair.priorLocator', value: target.oldLocator },
    { path: 'SidecarLocatorRepair.replacementLocator', value: result.freshLocator },
  ]);
  if (repairPrivacyDisclosure !== undefined) {
    sidecar.privacyDisclosure = repairPrivacyDisclosure;
    sidecar.caveats = [...(sidecar.caveats ?? []).filter((caveat) => !caveat.startsWith('Possible user data in')), repairPrivacyDisclosure.caveat];
  }

  let jsonWritten = false;
  try {
    // Both files are projections of this one in-memory sidecar. The Markdown
    // was proven to be an untouched projection before either write, and both
    // writes pass through the registered artifact boundary.
    writeArtifact('plan-json', absoluteJsonPath, `${JSON.stringify(sidecar, null, 2)}\n`, {
      privacyDisclosure: sidecar.privacyDisclosure,
      allowPrivacyDisclosure,
    });
    jsonWritten = true;
    writeArtifact('plan-md', absoluteMarkdownPath, `${renderPlanMarkdown(sidecar)}\n`, {
      privacyDisclosure: sidecar.privacyDisclosure,
      allowPrivacyDisclosure,
    });
  } catch (error) {
    return {
      kind: 'warning',
      message: jsonWritten
        ? partialPlanSyncWarning(
            result.specPath,
            jsonPath,
            markdownPath,
            target.oldLocator,
            result.freshLocator,
            `the Markdown projection could not be written (${describeIoError(error)})`,
          )
        : planSyncWarning(
            result.specPath,
            jsonPath,
            markdownPath,
            target.oldLocator,
            `the JSON projection could not be written (${describeIoError(error)})`,
          ),
    };
  }

  return {
    kind: 'synchronized',
    message: `Plan synchronized: ${jsonPath} + ${markdownPath} (recorded action ${stepIndex + 1}; locator-repair provenance recorded).`,
    sidecar,
  };
}

/**
 * The one JSON projection for fix-selector. Optional fields remain absent when
 * their corresponding post-apply phase did not run, preserving the bounded
 * envelope rather than serializing undefined values.
 */
export function formatFixSelectorJson(
  result: SelectorApplyResult,
  planSync?: { kind: string },
  confirmationMessage?: string,
  hashStatus?: { hashRecorded: false; reason: string },
): string {
  const publicResult = result.kind === 'refusal'
    ? result
    : (({ resolvedSpecPath: _resolvedSpecPath, specDisplayPath: _specDisplayPath, isDefaultSpecPath: _isDefaultSpecPath, ...rest }) => rest)(result);
  return JSON.stringify({
    result: publicResult,
    ...(planSync === undefined ? {} : { planSync: planSync.kind }),
    ...(confirmationMessage === undefined ? {} : { confirmationMessage }),
    ...(hashStatus === undefined ? {} : hashStatus),
  }, null, 2);
}

export function formatFixSelectorErrorJson(
  code: 'invalid-hand-finished-registry' | 'state-lock-held' | 'retirement-recovery-required' | 'state-lock-fenced',
  message: string,
): string {
  return JSON.stringify({ error: { code, message } }, null, 2);
}

const RELOCATED_SPEC_HASH_WITHHOLD_REASON = 'hash not recorded for a relocated spec (kept at its default-path keying)';

type StateHashWriteOutcome =
  | { kind: 'recorded' }
  | { kind: 'fenced' }
  | { kind: 'failed'; error: unknown };

function attemptStateHashWrite(action: () => void): StateHashWriteOutcome {
  try {
    action();
    return { kind: 'recorded' };
  } catch (error) {
    return error instanceof StateLockFencedError ? { kind: 'fenced' } : { kind: 'failed', error };
  }
}

function requireStateLockAcquisition(error: unknown): void {
  if (error !== undefined) throw error instanceof Error ? error : new Error(describeIoError(error));
}

/**
 * `fix-selector <slug>` uses the newest persisted patch evidence (heal
 * envelope or triage-latest store). It deliberately imports no adapter and
 * never fetches: default is preview-only, while `--apply` changes one
 * customer-selected emitted anchor.
 */
export function runFixSelector(argv: string[], deps: FixSelectorRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'fix-selector', deps.log)) return;
  const resolvedDeps = resolveFixSelectorRunDeps(deps);
  const args = parseFixSelectorArgs(argv);
  if (args.slug === undefined) {
    emitUsageError(args.json === true, buildUsageError('fix-selector'), resolvedDeps.log);
    process.exitCode = 1;
    return;
  }
  if (resolvedDeps.handFinishedRegistryError !== undefined) {
    const message = buildHandFinishedRegistryRefusal(resolvedDeps.handFinishedRegistryError);
    resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('invalid-hand-finished-registry', message) : message);
    process.exitCode = 1;
    return;
  }
  if (args.occurrenceProvided && args.occurrence === undefined) {
    emitUsageError(
      args.json === true,
      `--occurrence must be a positive whole number. Review the numbered occurrences, then run ` +
        `\`${TOOL_NAME} fix-selector ${args.slug} --apply --occurrence N\`.`,
      resolvedDeps.log,
    );
    process.exitCode = 1;
    return;
  }
  if (args.preferProvided && args.prefer === undefined) {
    emitUsageError(args.json === true, '--prefer must be either `stability` or `fidelity`.', resolvedDeps.log);
    process.exitCode = 1;
    return;
  }

  let stateLockHandle: StateLockHandle | undefined;
  let stateLockAcquisitionError: unknown;
  const publicationLedger = createStatePublicationLedger();
  if (args.apply) {
    try {
      stateLockHandle = acquireStateLock(path.join(resolvedDeps.workspaceRoot, '.replaytest', 'state'), 'fix-selector', { onProgress: resolvedDeps.progress }, args.stealStateLock === true);
    } catch (error) {
      if (error instanceof StateLockHeldError) {
        const message = stateLockHeldMessage('fix-selector', error.info, error.deadHolder);
        resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('state-lock-held', message) : message);
        process.exitCode = 1;
        return;
      }
      // The optional already-applied hash refresh has historically remained
      // best-effort when its state directory is read-only. Preserve that
      // narrow compatibility path; real contention/timeouts still refuse.
      if (!(typeof error === 'object' && error !== null && ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM'))) throw error;
      stateLockAcquisitionError = error;
    }
  }

  try {
  const result = applyPersistedSelectorPatch({
    slug: args.slug,
    apply: args.apply,
    occurrence: args.occurrence,
    ...(args.fromTriageVerdict === true ? { fromTriageVerdict: true } : {}),
    ...(args.prefer === undefined ? {} : { prefer: args.prefer }),
    workspaceRoot: resolvedDeps.workspaceRoot,
    generatedTestsDir: resolvedDeps.generatedTestsDir,
    healLatestPath: resolvedDeps.healLatestPath,
    triageEvidenceDir: resolvedDeps.triageEvidenceDir,
    lastRunStatePath: resolvedDeps.lastRunStatePath,
    reporterLastRunPath: resolvedDeps.reporterLastRunPath,
    selectorAppliesPath: resolvedDeps.selectorAppliesPath,
    now: resolvedDeps.now,
    handFinishedSlugs: resolvedDeps.handFinishedSlugs,
    allowPrivacyDisclosure: args.allowPrivacyDisclosure === true,
    progress: resolvedDeps.progress,
    ...(stateLockHandle === undefined ? {} : { stateLockHandle }),
    publicationLedger,
  });
  const alternate = args.prefer !== 'stability' && (result.kind === 'preview' || result.kind === 'applied')
    ? verifiedRecordedAlternateForSelectorRepair(
        result.slug,
        result.oldLocator,
        result.freshLocator,
        resolvedDeps.workspaceRoot,
        resolvedDeps.healLatestPath,
        resolvedDeps.triageEvidenceDir,
      )
    : undefined;
  const repairForPlanSync = result.kind === 'applied'
    ? result
    : args.apply === true && result.kind === 'already-applied'
      ? { ...result, appliedAt: (resolvedDeps.now ?? (() => new Date()))().toISOString() }
      : undefined;
  const planTarget = repairForPlanSync === undefined
    ? undefined
    : selectorPlanRepairTarget(
        repairForPlanSync,
        resolvedDeps.healLatestPath,
        resolvedDeps.triageEvidenceDir,
      );
  const planSync = repairForPlanSync === undefined
    ? undefined
    : planTarget === undefined
      ? {
          kind: 'warning' as const,
          message: planSyncWarning(
            repairForPlanSync.specPath,
            repairPlanDisplayPath(resolvedDeps.workspaceRoot, path.join(resolvedDeps.workspaceRoot, '.replaytest', 'plans', `${repairForPlanSync.slug}.plan.json`)),
            repairPlanDisplayPath(resolvedDeps.workspaceRoot, path.join(resolvedDeps.workspaceRoot, '.replaytest', 'plans', `${repairForPlanSync.slug}.md`)),
            repairForPlanSync.oldLocator,
            'the selected evidence did not identify one diagnosed plan locator',
          ),
        }
      : synchronizePlanAfterSelectorRepair(
          repairForPlanSync,
          resolvedDeps.workspaceRoot,
          planTarget,
          resolvedDeps.planArtifactWriter,
          args.allowPrivacyDisclosure === true,
        );
  const selectorResultMessage = result.kind === 'already-applied'
    ? [
        planSync?.kind === 'synchronized'
          ? formatSelectorApplyResult(result).replace(
              'Already applied — no change needed.',
              'The spec was already repaired; the stale plan mirror was synchronized.',
            )
          : planSync?.kind === 'already-synchronized'
            ? formatSelectorApplyResult(result).replace(
                'Already applied — no change needed.',
                'The spec and plan were already repaired; no change needed.',
              )
            : formatSelectorApplyResult(result),
        'This locator\'s earlier selector fix is still in place for this step.',
        ].join('\n')
    : formatSelectorApplyResult(result);
  let confirmationMessage: string | undefined;
  let hashStatus: { hashRecorded: false; reason: string } | undefined;
  if (result.kind === 'applied') {
    const recovery = retirementRecoveryMessage(result.slug, path.join(resolvedDeps.workspaceRoot, '.replaytest', 'retired'));
    if (recovery !== undefined) {
      resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('retirement-recovery-required', recovery) : recovery);
      process.exitCode = 1;
      return;
    }
    if (!result.isDefaultSpecPath) {
      hashStatus = { hashRecorded: false, reason: RELOCATED_SPEC_HASH_WITHHOLD_REASON };
    } else {
      const hashWrite = attemptStateHashWrite(() => {
        requireStateLockAcquisition(stateLockAcquisitionError);
        resolvedDeps.stampEmittedSpecHash(
          resolvedDeps.specEmittedHashesPath,
          resolvedDeps.workspaceRoot,
          result.slug,
          result.resolvedSpecPath,
          planSync?.kind === 'synchronized' || planSync?.kind === 'already-synchronized'
            ? planSync.sidecar
            : undefined,
          result.appliedAt,
          makeStateArtifactWriter({ stateLockHandle, publicationLedger }),
        );
      });
      if (hashWrite.kind === 'fenced') {
        const message = stateLockFencedMessage('fix-selector');
        resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('state-lock-fenced', message) : message);
        process.exitCode = 1;
        return;
      }
      if (hashWrite.kind === 'failed') confirmationMessage = `Selector patch, but its emitted-spec hash was not recorded (${describeIoError(hashWrite.error)}).`;
    }
  } else if (result.kind === 'already-applied' && planSync?.kind !== undefined &&
    (planSync.kind === 'synchronized' || planSync.kind === 'already-synchronized') && planTarget !== undefined) {
    const sourceRead: { kind: 'read'; source: string } | ConfirmedFixResolution = (() => {
      try {
        return { kind: 'read', source: fs.readFileSync(result.resolvedSpecPath, 'utf8') };
      } catch (error) {
        // Keep the plan sync truthful even when the optional spec read fails.
        return { kind: 'refused', reason: `the spec could not be read for confirmation (${describeIoError(error)})` };
      }
    })();
    const confirmation: ConfirmedFixResolution = sourceRead.kind === 'read'
      ? confirmedFixForAlreadyApplied(
        sourceRead.source,
        result,
        planTarget,
        (resolvedDeps.now ?? (() => new Date()))().toISOString(),
      )
      : sourceRead;
    const recovery = retirementRecoveryMessage(result.slug, path.join(resolvedDeps.workspaceRoot, '.replaytest', 'retired'));
    if (recovery !== undefined) {
      resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('retirement-recovery-required', recovery) : recovery);
      process.exitCode = 1;
      return;
    }
    if (!result.isDefaultSpecPath) {
      hashStatus = { hashRecorded: false, reason: RELOCATED_SPEC_HASH_WITHHOLD_REASON };
    } else {
      const hashWrite = attemptStateHashWrite(() => {
        requireStateLockAcquisition(stateLockAcquisitionError);
        resolvedDeps.refreshPlanAxisAfterAlreadyApplied(
          resolvedDeps.specEmittedHashesPath,
          resolvedDeps.workspaceRoot,
          result.slug,
          result.resolvedSpecPath,
          planSync.sidecar,
          confirmation.kind === 'confirmed' ? [confirmation.fix] : [],
          makeStateArtifactWriter({ stateLockHandle, publicationLedger }),
        );
      });
      if (hashWrite.kind === 'fenced') {
        const message = stateLockFencedMessage('fix-selector');
        resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('state-lock-fenced', message) : message);
        process.exitCode = 1;
        return;
      }
      if (hashWrite.kind === 'failed') {
        confirmationMessage = [
          'No selector patch was needed for this step; the existing selector still matches.',
          `Selector patch, but its emitted-spec hash was not recorded (${describeIoError(hashWrite.error)}).`,
        ].join('\n');
      }
    }
    if (confirmation.kind === 'refused') {
      confirmationMessage = [
        ...(confirmationMessage === undefined ? [] : [confirmationMessage]),
        `fix confirmation not recorded (${confirmation.reason})`,
      ].join('\n');
    }
  }
  if (args.json === true) {
    resolvedDeps.log(formatFixSelectorJson(result, planSync, confirmationMessage, hashStatus));
  } else {
    resolvedDeps.log(formatTerminalTimestamps([
      selectorResultMessage,
      ...(alternate === undefined ? [] : [formatRecordedAlternateOption(alternate)]),
      ...(planSync === undefined ? [] : [planSync.message]),
      ...(confirmationMessage === undefined ? [] : [confirmationMessage]),
      ...(hashStatus === undefined ? [] : [hashStatus.reason]),
    ].join('\n')));
  }
  if (result.kind === 'refusal') process.exitCode = result.exitCode;
  } finally {
    if (stateLockHandle !== undefined) {
      releaseStateLockWithDisclosure(stateLockHandle, publicationLedger, 'fix-selector', resolvedDeps.progress);
    }
  }
}
