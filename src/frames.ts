/**
 * `frames` — turn one recorded journey behind a reviewed plan into local,
 * per-step DOM and screenshot context for a coding agent.
 *
 * This module deliberately consumes only neutral sessions, neutral replay
 * windows, and the renderer seam. Provider transport, raw recording ids, and
 * browser startup all stay behind their respective adapters/modules.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { emitArtifact } from './artifact-registry.js';
import { segmentJourneys, type Journey } from './journeys.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';
import { findPiiLikeStrings, type PiiLintFinding } from './pii-lint.js';
import { journeySignature } from './selection.js';
import { needsSegmentationReview, SEGMENTATION_MIGRATION_REVIEW_NOTE, type Sidecar } from './sidecar.js';
import type {
  CaptureKind,
  CaptureRequest,
  CaptureResult,
  RenderCapturesOptions,
} from './frames-render.js';
import type { ReplayStreamWindow } from './providers/posthog-adapter.js';

export const DEFAULT_FRAMES_CAP = 15;
export const FRAMES_RENDERER = '@rrweb/replay@2.1.0';
/** Fallback when a set-aside replay window carries no decode reason of its own. */
const REPLAY_UNREADABLE_FALLBACK = 'None of its recorded events could be read.';
const CLAMPED_CAVEAT =
  'Step timestamp is at or after the recording\'s last event — showing the final recorded state at the clamped offset.';
// Both partial caveats end with the same pointer to the saved file, so a
// person reading manifest.json finds it the same way for either one.
const PARTIAL_SAVED_FILE_NOTE = 'What was saved is listed in this entry (htmlFile or pngFile).';
const CLAMPED_PARTIAL_CAVEAT =
  `Step timestamp is at or after the recording's last event; only part of this capture was drawn, so it may not show the complete final recorded state. ${PARTIAL_SAVED_FILE_NOTE}`;
// A clamped capture with no picture (not drawn, ambiguous, or not returned)
// must not claim to show anything.
const CLAMPED_UNDRAWN_CAVEAT =
  'Step timestamp is at or after the recording\'s last event; no picture of the final recorded state could be drawn.';
const PARTIAL_CAPTURE_CAVEAT =
  `Only part of this capture was drawn. ${PARTIAL_SAVED_FILE_NOTE}`;
// A screenshot saved without its page HTML may follow a failed pause, which
// leaves the replayer where the previous capture stopped.
const SCREENSHOT_ONLY_PARTIAL_CAVEAT =
  'The page could not be read at this point, so this screenshot may show an earlier moment of the recording.';
const RENDERER_DID_NOT_RETURN_REASON = 'The renderer did not return this capture.';
const NO_CAPTURE_OUTPUT_REASON = 'The renderer returned no page content or screenshot for this capture.';

export interface FrameStepRange {
  first: number;
  last: number;
}

export interface FramesRunOptions {
  slug: string;
  sessionId?: string;
  /** Raw `a-b` CLI value; parsed here so the command logic owns its meaning. */
  steps?: string;
  all: boolean;
  allowUnignored: boolean;
}

export interface FrameStep {
  /** One-based journey-step ordinal, used in stable artifact filenames. */
  step: number;
  kind: NeutralStep['kind'];
  at: string;
  url: string;
  relevant: boolean;
  caveats: string[];
}

export interface PlannedCapture {
  id: string;
  step: number;
  kind: CaptureKind;
  offsetMs: number;
  /** Present only when replay-window bounds changed the requested offset. */
  requestedOffsetMs?: number;
  url: string;
  caveats: string[];
}

export interface OmittedFrame {
  step: number;
  reason: string;
}

export interface CapturePlan {
  captures: PlannedCapture[];
  omitted: OmittedFrame[];
}

export type FrameCaptureFidelity = CaptureResult['fidelity'] | 'ambiguous-window' | 'clamped';

export interface FramesManifestCapture {
  step: number;
  kind: CaptureKind;
  /** Effective renderer offset; preserved for compatibility with v1 manifests. */
  offsetMs: number;
  /** Present together when a requested capture time was clamped to the replay window. */
  requestedOffsetMs?: number;
  effectiveOffsetMs?: number;
  url: string;
  htmlFile?: string;
  pngFile?: string;
  fidelity: FrameCaptureFidelity;
  reason?: string;
  containsPii: boolean;
  piiFindings?: PiiLintFinding[];
  caveats: string[];
}

export interface FramesManifest {
  slug: string;
  sessionId: string;
  generatedAt: string;
  renderer: typeof FRAMES_RENDERER;
  planFingerprint: string;
  signatureSemanticsVersion: number | null;
  /** Unknown rather than guessed: a sidecar does not retain corpus counts. */
  exemplarOf: number | null;
  containsUserContent: true;
  handling: {
    localOnly: true;
    doNotCommit: true;
    agentUse: 'structure-not-people';
  };
  viewport?: { width: number; height: number };
  captures: FramesManifestCapture[];
  omitted: OmittedFrame[];
}

export type FramesRunResult =
  | { kind: 'written'; manifest: FramesManifest; outputDir: string; warnings: string[] }
  | { kind: 'refusal'; message: string; exitCode: 1; warnings?: string[] };

export interface FramesRunDeps {
  plansDir: string;
  framesDir: string;
  workspaceRoot: string;
  fetchNeutralSessions: (distinctId: string, sessionId?: string) => Promise<NeutralSession[]>;
  fetchFullReplayStream: (sessionId: string) => Promise<ReplayStreamWindow[]>;
  renderCaptures: (
    replayWindow: ReplayStreamWindow,
    requests: CaptureRequest[],
    options?: RenderCapturesOptions,
  ) => Promise<CaptureResult[]>;
  /** Test seam around `git check-ignore .replaytest/frames`. */
  isFramesDirectoryIgnored?: (workspaceRoot: string) => boolean;
  /** Test seam that distinguishes an unignored directory from a non-git workspace. */
  framesDirectoryIgnoreStatus?: (workspaceRoot: string) => FramesDirectoryIgnoreStatus;
  now?: () => Date;
}

type FramesDirectoryIgnoreStatus = 'ignored' | 'unignored' | 'no-git-repository' | 'git-unavailable';

/** Parses the targeted-retrieval form `--steps 3-8`. */
export function parseFrameStepRange(value: string): FrameStepRange | undefined {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (match === null) return undefined;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return undefined;
  return { first, last };
}

export function buildFramesUsageError(): string {
  return 'Usage: replaytest frames <slug> [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]';
}

export function buildFramesMissingPlanMessage(sidecarDisplayPath: string): string {
  return `No plan found at ${sidecarDisplayPath} — run: replaytest plan <distinctId>`;
}

export function buildFramesPlanPredatesMessage(distinctId: string, sessionId: string): string {
  return (
    'This plan predates the current pipeline — re-run: ' +
    `replaytest plan ${distinctId} --session ${sessionId}`
  );
}

export function buildFramesUnavailableMessage(): string {
  return 'Recording expired or unavailable; frames unavailable — the plan and spec are still valid.';
}

export function buildFramesUnignoredRefusal(): string {
  return (
    '.replaytest/frames is not ignored by git — refusing to write real session content where it could be committed. ' +
    'Add .replaytest/ to .gitignore, or pass --allow-unignored only when you have deliberately secured this folder.'
  );
}

export function buildFramesNoGitRepositoryRefusal(): string {
  return (
    'No git repository found for this workspace — refusing to write real session content without a local ignore rule. ' +
    'Pass --allow-unignored only when you have deliberately secured this folder.'
  );
}

export function buildFramesGitUnavailableRefusal(): string {
  return (
    'Git is unavailable — cannot determine whether .replaytest/frames is ignored. ' +
    'Pass --allow-unignored only when you have deliberately secured this folder.'
  );
}

export function buildFramesGitPermissionDeniedRefusal(): string {
  return (
    'Git is unavailable because the git binary is permission-denied — cannot determine whether .replaytest/frames is ignored. ' +
    'Pass --allow-unignored only when you have deliberately secured this folder.'
  );
}

export function buildFramesUnignoredWarning(ignoreStatus: Exclude<FramesDirectoryIgnoreStatus, 'ignored'>): string {
  if (ignoreStatus === 'git-unavailable') {
    return 'Warning: git is unavailable, so replaytest cannot determine whether .replaytest/frames is git-ignored. Frames contain real session content — keep this folder local and never commit/share it.';
  }
  return ignoreStatus === 'no-git-repository'
    ? 'Warning: no git repository was found, so .replaytest/frames has no git-ignore protection. Frames contain real session content — keep this folder local and never commit/share it.'
    : 'Warning: .replaytest/frames is not ignored by git. Frames contain real session content — keep this folder local and never commit/share it.';
}

/** The source lineage fingerprint deliberately excludes only wall-clock plan generation time. */
export function fingerprintSidecar(sidecar: Sidecar): string {
  const { generatedAt: _generatedAt, ...source } = sidecar.source;
  const stableForFingerprint = { ...sidecar, source };
  return createHash('sha256').update(JSON.stringify(stableForFingerprint)).digest('hex');
}

/** Stable artifact stem. `at` is intentionally unsuffixed for the common case. */
export function frameArtifactStem(step: number, kind: CaptureKind): string {
  const prefix = `step-${String(step).padStart(2, '0')}`;
  if (kind === 'pre-submit') return `${prefix}-pre-submit`;
  if (kind === 'next-recorded-state') return `${prefix}-next-recorded-state`;
  return prefix;
}

function captureFor(step: FrameStep, kind: CaptureKind, offsetMs: number): PlannedCapture {
  const id = frameArtifactStem(step.step, kind);
  return { id, step: step.step, kind, offsetMs, url: step.url, caveats: step.caveats };
}

function stepOffset(step: FrameStep, firstTimestampMs: number): number {
  return Math.max(0, Date.parse(step.at) - firstTimestampMs);
}

function nextRecordedOffset(steps: FrameStep[], index: number, firstTimestampMs: number): number {
  const current = stepOffset(steps[index], firstTimestampMs);
  const following = steps[index + 1];
  if (following === undefined) return current + 2_000;
  return Math.max(current, Math.min(stepOffset(following, firstTimestampMs) - 1, current + 2_000));
}

function pairForSubmit(steps: FrameStep[], index: number, firstTimestampMs: number): PlannedCapture[] {
  const step = steps[index];
  const at = stepOffset(step, firstTimestampMs);
  return [
    captureFor(step, 'pre-submit', Math.max(0, at - 1)),
    captureFor(step, 'next-recorded-state', nextRecordedOffset(steps, index, firstTimestampMs)),
  ];
}

function requestedStepSet(steps: FrameStep[], range: FrameStepRange | undefined): Set<number> {
  return new Set(steps.filter((step) => range === undefined || (step.step >= range.first && step.step <= range.last)).map((step) => step.step));
}

/**
 * The refusal for a run that would plan no captures. It never rebuilds a
 * command line: the user's other flags (`--session`, `--from-archive`,
 * `--allow-unignored`) are theirs to keep, so it names only the range to use.
 */
export function buildFramesEmptySelectionMessage(
  steps: FrameStep[],
  requestedRange: FrameStepRange | undefined,
): string {
  if (steps.length > 0 && requestedRange !== undefined) {
    const firstStep = steps[0].step;
    const lastStep = steps[steps.length - 1].step;
    return (
      `Requested --steps ${requestedRange.first}-${requestedRange.last} matches no steps in this journey (steps ${firstStep}-${lastStep}). ` +
      `Run the same command with --steps ${firstStep}-${lastStep}, or without --steps.`
    );
  }
  // Defensive: not reachable today. Every journey has at least one step
  // (journeys are kept only when they hold an interaction), and without
  // --steps the journey's last step is always captured, so only an
  // out-of-range --steps can select nothing.
  return 'No frame captures could be selected for this journey.';
}

/**
 * The note for a --steps range that runs past the journey's last step but
 * still selects something; undefined when the range lies inside the journey.
 */
export function buildFramesRangePastJourneyWarning(
  steps: FrameStep[],
  requestedRange: FrameStepRange | undefined,
): string | undefined {
  if (requestedRange === undefined || steps.length === 0) return undefined;
  const lastStep = steps[steps.length - 1].step;
  if (requestedRange.last <= lastStep || requestedRange.first > lastStep) return undefined;
  const pastFirst = lastStep + 1;
  const past = pastFirst === requestedRange.last
    ? `step ${pastFirst} is`
    : `steps ${pastFirst}-${requestedRange.last} are`;
  const capturing = requestedRange.first === lastStep
    ? `step ${lastStep}`
    : `steps ${requestedRange.first}-${lastStep}`;
  return `Warning: ${past} past this journey's last step (${lastStep}); the range covers ${capturing}.`;
}

/**
 * Applies the resolved selection policy. Submit pairs are an atomic group
 * for cap accounting: the pair consumes two slots or is omitted as a pair.
 * `--all` and `--steps` deliberately bypass the cap/priority policy.
 */
export function selectFrameCaptures(
  steps: FrameStep[],
  firstTimestampMs: number,
  opts: { cap?: number; all?: boolean; range?: FrameStepRange } = {},
): CapturePlan {
  if (steps.length === 0) return { captures: [], omitted: [] };

  const cap = opts.cap ?? DEFAULT_FRAMES_CAP;
  const requested = requestedStepSet(steps, opts.range);
  const bypassCap = opts.all === true || opts.range !== undefined;
  const captures: PlannedCapture[] = [];
  const omitted: OmittedFrame[] = [];
  const selectedIds = new Set<string>();

  const add = (capture: PlannedCapture): void => {
    if (!selectedIds.has(capture.id)) {
      selectedIds.add(capture.id);
      captures.push(capture);
    }
  };
  const recordOutsideRange = (step: FrameStep): boolean => {
    if (requested.has(step.step)) return false;
    omitted.push({ step: step.step, reason: `Outside requested --steps ${opts.range?.first}-${opts.range?.last} range.` });
    return true;
  };

  if (bypassCap) {
    for (const [index, step] of steps.entries()) {
      if (recordOutsideRange(step)) continue;
      add(captureFor(step, 'at', stepOffset(step, firstTimestampMs)));
      if (step.kind === 'submit') {
        for (const capture of pairForSubmit(steps, index, firstTimestampMs)) add(capture);
      }
    }
    return { captures, omitted };
  }

  const terminal = steps[steps.length - 1];
  add(captureFor(terminal, 'at', stepOffset(terminal, firstTimestampMs)));

  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'submit') continue;
    const pair = pairForSubmit(steps, index, firstTimestampMs);
    if (captures.length + pair.length <= cap) {
      for (const capture of pair) add(capture);
    } else {
      omitted.push({ step: step.step, reason: `Capture cap of ${cap} leaves no room for this two-capture submit pair.` });
    }
  }

  const regular = (step: FrameStep): void => {
    const capture = captureFor(step, 'at', stepOffset(step, firstTimestampMs));
    if (selectedIds.has(capture.id)) return;
    if (captures.length < cap) add(capture);
    else omitted.push({ step: step.step, reason: `Capture cap of ${cap} reached.` });
  };

  for (const step of steps) if (step.relevant) regular(step);
  for (const step of steps) regular(step);

  return { captures, omitted };
}

function neutralTargetText(step: NeutralStep): string[] {
  const target = step.target;
  if (target === undefined) return [];
  return [target.text, target.ariaLabel, target.labelText, target.placeholder, target.name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());
}

/** Best-effort evidence priority only; it never invents a selector or a fact. */
function sidecarCaveatsForStep(step: NeutralStep, sidecar: Sidecar): string[] {
  const caveats = sidecar.caveats ?? [];
  const targetText = neutralTargetText(step);
  return caveats.filter((caveat) => targetText.some((text) => caveat.toLowerCase().includes(text)));
}

function isMaskedOrTodoRelevant(step: NeutralStep, sidecar: Sidecar, caveats: string[]): boolean {
  if (caveats.length > 0) return true;
  if (step.kind === 'submit') return sidecar.steps.some((candidate) =>
    candidate.isSubmit && (candidate.maskedFieldLabel !== undefined || candidate.maskedFieldLabels !== undefined),
  );
  const targetText = neutralTargetText(step);
  return sidecar.steps.some((candidate) => {
    const label = candidate.label.toLowerCase();
    const corresponds = targetText.some((text) => text === label || text.includes(label) || label.includes(text));
    return corresponds && (candidate.masked === true || candidate.locator.length === 0);
  });
}

export function toFrameSteps(journey: Journey, sidecar: Sidecar): FrameStep[] {
  return journey.steps.map((step, index) => {
    const caveats = sidecarCaveatsForStep(step, sidecar);
    return {
      step: index + 1,
      kind: step.kind,
      at: step.at,
      url: step.url,
      relevant: isMaskedOrTodoRelevant(step, sidecar, caveats),
      caveats,
    };
  });
}

export function selectJourneyBySidecarSignature(
  sessions: NeutralSession[],
  sidecar: Sidecar,
  sessionId: string,
): Journey | undefined {
  if (sidecar.source.signature === undefined || sidecar.source.signature.length === 0) return undefined;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return undefined;
  return segmentJourneys(session).find(
    (journey) => journeySignature(journey, sidecar.source.wizardStepParamNames) === sidecar.source.signature,
  );
}

export function selectReplayWindowsForJourney(windows: ReplayStreamWindow[], journey: Journey): ReplayStreamWindow[] {
  // Overlap, not strict bracketing: journey event timestamps routinely extend
  // past the recording stream's bounds (trailing events flush after the last
  // rrweb emission), so requiring containment refuses real recordings.
  const start = Date.parse(journey.startedAt);
  const end = Date.parse(journey.endedAt);
  return windows.filter((window) => window.firstTimestampMs <= end && window.lastTimestampMs >= start);
}

function isFramesDirectoryIgnored(workspaceRoot: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '.replaytest/frames'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isGitUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EACCES';
}

interface FramesDirectoryIgnoreCheck {
  status: FramesDirectoryIgnoreStatus;
  gitPermissionDenied: boolean;
}

function getFramesDirectoryIgnoreStatus(workspaceRoot: string): FramesDirectoryIgnoreCheck {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
  } catch (error) {
    return isGitUnavailable(error)
      ? { status: 'git-unavailable', gitPermissionDenied: (error as NodeJS.ErrnoException).code === 'EACCES' }
      : { status: 'no-git-repository', gitPermissionDenied: false };
  }
  return { status: isFramesDirectoryIgnored(workspaceRoot) ? 'ignored' : 'unignored', gitPermissionDenied: false };
}

function readSidecar(sidecarPath: string): Sidecar | undefined {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
  } catch {
    return undefined;
  }
}

function readPreviousManifest(outputDir: string): FramesManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8')) as FramesManifest;
  } catch {
    return undefined;
  }
}

function plainError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.split('\n')[0];
  return 'an unexpected local error';
}

function buildAgentBrief(slug: string, sessionId: string): string {
  return `# Replay frames agent brief (v1)

## What this folder is

This folder is local replay context for one historical user journey behind the reviewed plan \`${slug}\`. It contains reconstructed DOM snapshots and screenshots, not a new source of product requirements.

## Command that made it

\`replaytest frames ${slug} --session ${sessionId}\`

## Privacy and handling

These frames may contain on-screen PII, including real names and email addresses: PostHog masks typed inputs but not visible on-screen text. They stay local in this folder — treat it as sensitive, and never commit it to version control or publish it. Sending them anywhere, including to a cloud AI agent, is YOUR deliberate choice. We never redact these exports and never claim they are safe to share. Use them for structure, not people — quote structure, never people.

## Evidence limits

- This is one historical exemplar; it is not the canonical behavior of every user or session.
- Visual text is never an assertion source. Keep Tier-1 assertions tied to witnessed plan facts.
- An unchanged \`next-recorded-state\` frame does not mean nothing happened.
- A \`clamped\` capture's step time is at or after the recording's last event, so it shows the final recorded state, not the moment the step asked for. Compare its \`requestedOffsetMs\` and \`effectiveOffsetMs\` in the manifest.
- A \`partial\` capture is missing its page HTML or its screenshot. The manifest lists which file was saved; read the caveats before relying on it.
- A \`partial\` or \`not-renderable\` capture whose step time was at or after the recording's last event also carries \`requestedOffsetMs\` and \`effectiveOffsetMs\`.
- A \`not-renderable\` capture couldn't be drawn. Its \`reason\` in the manifest says why, and it has no HTML or PNG file.
- An \`ambiguous-window\` capture was not drawn because this journey's time matched more than one recorded window; it has no HTML or PNG file, and when its step time was at or after the recording's last event it also carries \`requestedOffsetMs\` and \`effectiveOffsetMs\`.
- Masked boxes stay masked. Do not infer or reconstruct masked values.
- Never derive NEW expected behavior from an apparent visual result.

## How to consume it

1. Read \`manifest.json\` first for lineage, fidelity, caveats, and file names.
2. Grep the HTML for facts about labels, roles, and structure.
3. Open a PNG only for visual truth such as layout or masked-field appearance.
`;
}

interface PreparedManifestCapture {
  manifest: FramesManifestCapture;
  html?: string;
  pngBuffer?: Buffer;
}

function buildManifestCapture(
  capture: PlannedCapture,
  result: CaptureResult | undefined,
  fidelity: FrameCaptureFidelity,
): PreparedManifestCapture {
  const html = result?.html;
  const findings = html === undefined ? [] : findPiiLikeStrings(html);
  // Save only non-empty output, so a partial capture never leaves an empty
  // HTML or PNG file that looks like a picture to anything listing the folder.
  const canWriteFiles = result !== undefined && fidelity !== 'ambiguous-window' && fidelity !== 'not-renderable';
  const hasHtmlFile = canWriteFiles && html !== undefined && html.length > 0;
  const hasPngFile = canWriteFiles && result.pngBuffer.length > 0;
  const stem = frameArtifactStem(capture.step, capture.kind);
  const wasClamped = capture.requestedOffsetMs !== undefined;
  const caveats = capture.caveats.map((caveat) => {
    if (caveat !== CLAMPED_CAVEAT) return caveat;
    if (fidelity === 'ambiguous-window' || fidelity === 'not-renderable') return CLAMPED_UNDRAWN_CAVEAT;
    return fidelity === 'partial' ? CLAMPED_PARTIAL_CAVEAT : caveat;
  });
  if (fidelity === 'partial' && !wasClamped) caveats.push(PARTIAL_CAPTURE_CAVEAT);
  if (fidelity === 'partial' && hasPngFile && !hasHtmlFile) caveats.push(SCREENSHOT_ONLY_PARTIAL_CAVEAT);
  if (fidelity === 'ambiguous-window') caveats.push('Several recorded windows bracket this journey; no window was rendered automatically.');
  // A capture the renderer did not return says so once, in its `reason`.
  const reason = result?.reason ?? (
    fidelity === 'ambiguous-window'
      ? undefined
      : result === undefined
        ? RENDERER_DID_NOT_RETURN_REASON
        : !hasHtmlFile && !hasPngFile
          ? NO_CAPTURE_OUTPUT_REASON
          : undefined
  );
  return {
    manifest: {
      step: capture.step,
      kind: capture.kind,
      offsetMs: capture.offsetMs,
      ...(wasClamped
        ? { requestedOffsetMs: capture.requestedOffsetMs, effectiveOffsetMs: capture.offsetMs }
        : {}),
      url: capture.url,
      ...(hasHtmlFile ? { htmlFile: `${stem}.html` } : {}),
      ...(hasPngFile ? { pngFile: `${stem}.png` } : {}),
      fidelity,
      ...(reason === undefined ? {} : { reason }),
      containsPii: findings.length > 0,
      ...(findings.length > 0 ? { piiFindings: findings } : {}),
      caveats,
    },
    ...(hasHtmlFile ? { html } : {}),
    ...(hasPngFile ? { pngBuffer: result.pngBuffer } : {}),
  };
}

function sharedStateNote(
  medium: 'DOM HTML' | 'PNG screenshot',
  previous: FramesManifestCapture,
): string {
  const change = medium === 'DOM HTML' ? 'DOM' : 'visual';
  return (
    `${medium} is identical to step ${previous.step} (${previous.kind}); ` +
    `the recording carries no ${change} change between these captures.`
  );
}

/**
 * Consecutive replay captures commonly render the same state after their
 * offsets have been clamped. Keep every capture in the manifest, while each
 * medium reuses the immediately preceding byte-identical artifact.
 */
function deduplicateConsecutiveCaptureFiles(prepared: PreparedManifestCapture[]): void {
  let previousHtml: { content: string; file: string; manifest: FramesManifestCapture } | undefined;
  let previousPng: { content: Buffer; file: string; manifest: FramesManifestCapture } | undefined;

  for (const current of prepared) {
    const manifest = current.manifest;

    if (manifest.htmlFile !== undefined && current.html !== undefined) {
      if (previousHtml !== undefined && current.html === previousHtml.content) {
        manifest.htmlFile = previousHtml.file;
        manifest.caveats.push(sharedStateNote('DOM HTML', previousHtml.manifest));
      }
      previousHtml = { content: current.html, file: manifest.htmlFile, manifest };
    } else {
      previousHtml = undefined;
    }

    if (manifest.pngFile !== undefined && current.pngBuffer !== undefined) {
      // A screenshot-only partial may follow a failed pause, leaving the
      // replayer at an earlier state. Keep it as its own artifact and never
      // use it as the comparison source for a later capture.
      const uncertainScreenshot = manifest.fidelity === 'partial' && manifest.htmlFile === undefined;
      if (!uncertainScreenshot && previousPng !== undefined && current.pngBuffer.equals(previousPng.content)) {
        manifest.pngFile = previousPng.file;
        manifest.caveats.push(sharedStateNote('PNG screenshot', previousPng.manifest));
      }
      previousPng = uncertainScreenshot
        ? undefined
        : { content: current.pngBuffer, file: manifest.pngFile, manifest };
    } else {
      previousPng = undefined;
    }
  }
}

/** Formats the one concise command-boundary result for the CLI. */
export function formatFramesRunResult(result: FramesRunResult): string[] {
  if (result.kind === 'refusal') return [...(result.warnings ?? []), result.message];
  // Count only captures with at least one saved picture file (a capture that
  // shares an identical earlier file counts), so the line never claims
  // pictures that were not written.
  const total = result.manifest.captures.length;
  const withFiles = result.manifest.captures.filter(
    (capture) => capture.htmlFile !== undefined || capture.pngFile !== undefined,
  ).length;
  // Defensive: `runFrames` refuses a run that plans no captures before it
  // writes anything, so a written result always has at least one capture.
  // The branch stays so an empty list can never be described as pictures
  // that were omitted.
  const wroteLine = total === 0
    ? 'No frame captures were planned.'
    : withFiles === 0
      ? `No picture files were written. manifest.json in ${result.outputDir} lists each frame capture and why none of them has a picture.`
      : withFiles === total
        ? `Wrote ${total} frame capture(s) to ${result.outputDir}`
        : `Wrote ${withFiles} of ${total} frame capture(s) to ${result.outputDir}`;
  // The sensitivity warning is about saved pictures, so it is printed only
  // when at least one picture file was written.
  return [
    ...result.warnings,
    wroteLine,
    ...(withFiles === 0
      ? []
      : [
          'Frame sensitivity warning:',
          'Frames may contain on-screen PII, including real names or email addresses.',
          'They stay local. Sending them anywhere, including to a cloud AI agent, is your deliberate choice.',
          'We never redact exported frames and never claim they are safe to share.',
        ]),
  ];
}

/**
 * The command's side-effecting core. It only starts writing after the git
 * ignore gate passes; fetch and rendering are injected seams for unit tests.
 */
export async function runFrames(options: FramesRunOptions, deps: FramesRunDeps): Promise<FramesRunResult> {
  const sidecarPath = path.join(deps.plansDir, `${options.slug}.plan.json`);
  const sidecarDisplay = path.relative(deps.workspaceRoot, sidecarPath) || sidecarPath;
  if (!fs.existsSync(sidecarPath)) {
    return { kind: 'refusal', message: buildFramesMissingPlanMessage(sidecarDisplay), exitCode: 1 };
  }

  const sidecar = readSidecar(sidecarPath);
  if (sidecar === undefined) {
    return { kind: 'refusal', message: `Could not read plan at ${sidecarDisplay}.`, exitCode: 1 };
  }
  if (options.steps !== undefined && parseFrameStepRange(options.steps) === undefined) {
    return { kind: 'refusal', message: '--steps must be a one-based range such as 3-8.', exitCode: 1 };
  }

  const ignoreCheck: FramesDirectoryIgnoreCheck = deps.framesDirectoryIgnoreStatus === undefined
    ? (deps.isFramesDirectoryIgnored === undefined
      ? getFramesDirectoryIgnoreStatus(deps.workspaceRoot)
      : { status: deps.isFramesDirectoryIgnored(deps.workspaceRoot) ? 'ignored' : 'unignored', gitPermissionDenied: false })
    : { status: deps.framesDirectoryIgnoreStatus(deps.workspaceRoot), gitPermissionDenied: false };
  const ignoreStatus = ignoreCheck.status;
  const ignored = ignoreStatus === 'ignored';
  const warnings = !ignored && options.allowUnignored ? [buildFramesUnignoredWarning(ignoreStatus)] : [];
  if (ignoreStatus === 'git-unavailable' && !options.allowUnignored) {
    return {
      kind: 'refusal',
      message: ignoreCheck.gitPermissionDenied ? buildFramesGitPermissionDeniedRefusal() : buildFramesGitUnavailableRefusal(),
      exitCode: 1,
    };
  }
  if (ignoreStatus === 'no-git-repository' && !options.allowUnignored) {
    return { kind: 'refusal', message: buildFramesNoGitRepositoryRefusal(), exitCode: 1 };
  }
  if (!ignored && !options.allowUnignored) {
    return { kind: 'refusal', message: buildFramesUnignoredRefusal(), exitCode: 1 };
  }

  const sessionId = options.sessionId ?? sidecar.source.sessionId;
  let sessions: NeutralSession[];
  try {
    sessions = await deps.fetchNeutralSessions(sidecar.source.distinctId, sessionId);
  } catch (error) {
    return {
      kind: 'refusal',
      message: `Frames could not recover the recorded session: ${plainError(error)}.`,
      exitCode: 1,
      warnings,
    };
  }

  const journey = selectJourneyBySidecarSignature(sessions, sidecar, sessionId);
  if (journey === undefined) {
    return {
      kind: 'refusal',
      message: `${needsSegmentationReview(sidecar.source) ? `${SEGMENTATION_MIGRATION_REVIEW_NOTE} ` : ''}${buildFramesPlanPredatesMessage(sidecar.source.distinctId, sessionId)}`,
      exitCode: 1,
      warnings,
    };
  }
  const outcomeWarning = frameOutcomeWarning(journey);
  if (outcomeWarning !== undefined) warnings.push(outcomeWarning);

  // Which steps are captured depends only on the journey's steps and the
  // requested range, never on the recording's timestamps, so a selection
  // that plans nothing is refused here: before the full recording is pulled,
  // and before an unavailable recording could hide the range problem.
  const frameSteps = toFrameSteps(journey, sidecar);
  const range = options.steps === undefined ? undefined : parseFrameStepRange(options.steps);
  if (selectFrameCaptures(frameSteps, 0, { all: options.all, range }).captures.length === 0) {
    return {
      kind: 'refusal',
      message: buildFramesEmptySelectionMessage(frameSteps, range),
      exitCode: 1,
      warnings,
    };
  }
  const rangeWarning = buildFramesRangePastJourneyWarning(frameSteps, range);
  if (rangeWarning !== undefined) warnings.push(rangeWarning);

  let windows: ReplayStreamWindow[];
  try {
    windows = await deps.fetchFullReplayStream(sessionId);
  } catch (error) {
    return {
      kind: 'refusal',
      message: `Frames could not fetch recorded windows: ${plainError(error)}.`,
      exitCode: 1,
      warnings,
    };
  }
  if (windows.length === 0) {
    return { kind: 'refusal', message: buildFramesUnavailableMessage(), exitCode: 1, warnings };
  }

  const overlapping = selectReplayWindowsForJourney(windows, journey);
  if (overlapping.length === 0) {
    return {
      kind: 'refusal',
      message: 'Recorded windows do not bracket this journey; frames unavailable — the plan and spec are still valid.',
      exitCode: 1,
      warnings,
    };
  }
  // A window none of whose events could be read cannot be drawn. It must not
  // make a readable window ambiguous or be picked ahead of it; it is set
  // aside, and its reason travels with every capture. When no overlapping
  // window is readable, the first one is used so each capture comes out
  // not-renderable with its reason.
  const readable = overlapping.filter((window) => window.events.length > 0);
  const setAside = readable.length > 0 ? overlapping.filter((window) => window.events.length === 0) : [];
  const attributable = readable.length > 0 ? readable : [overlapping[0]];
  const setAsideCaveats = [...new Set(setAside.flatMap((window) => window.decodeIssues ?? [REPLAY_UNREADABLE_FALLBACK]))]
    .map((reason) => `Another recorded window overlapping this journey couldn't be read and was skipped: ${reason}`);
  for (const caveat of setAsideCaveats) warnings.push(`Warning: ${caveat}`);

  // Same selection as the check above, now with real offsets, so it plans at
  // least one capture.
  const plan = selectFrameCaptures(frameSteps, attributable[0].firstTimestampMs, { all: options.all, range });
  // Overlap-selected windows can leave step offsets at or past the recording's
  // last event; render the final recorded state there and say so per capture.
  // The replayer applies only events strictly BEFORE the pause point, so the
  // end of the recording is one millisecond past its last event — otherwise
  // the last recorded change would be missing from the final-state picture.
  // An offset exactly AT the last event is treated as the end too: the
  // recording has nothing later to show, and leaving it unclamped would label
  // `complete` a picture that silently omits that last recorded change.
  const lastEventOffsetMs = attributable[0].lastTimestampMs - attributable[0].firstTimestampMs;
  const endOfRecordingOffsetMs = lastEventOffsetMs + 1;
  for (const capture of plan.captures) {
    if (capture.offsetMs >= lastEventOffsetMs) {
      capture.requestedOffsetMs = capture.offsetMs;
      capture.offsetMs = endOfRecordingOffsetMs;
      capture.caveats = [...capture.caveats, CLAMPED_CAVEAT];
    }
    if (setAsideCaveats.length > 0) capture.caveats = [...capture.caveats, ...setAsideCaveats];
  }
  const outputDir = path.join(deps.framesDir, options.slug);
  const previous = readPreviousManifest(outputDir);
  const planFingerprint = fingerprintSidecar(sidecar);
  if (previous !== undefined && previous.planFingerprint !== planFingerprint) {
    warnings.push('Warning: this plan changed since these frames were last generated; the folder is being refreshed from the current plan.');
  }

  let rendered: CaptureResult[] = [];
  let ambiguous = attributable.length > 1;
  if (!ambiguous) {
    try {
      rendered = await deps.renderCaptures(
        attributable[0],
        plan.captures.map(({ id, kind, offsetMs }) => ({ id, kind, offsetMs })),
        sidecar.viewport === undefined ? {} : { viewport: sidecar.viewport },
      );
    } catch (error) {
      return {
        kind: 'refusal',
        // CustomerPlaywrightUnavailableError's plain install hint is intentionally preserved verbatim.
        message: plainError(error),
        exitCode: 1,
        warnings,
      };
    }
  }

  const resultsById = new Map(rendered.map((result) => [result.id, result]));
  const prepared = plan.captures.map((capture) => {
    const result = resultsById.get(capture.id);
    const hasHtml = result !== undefined && result.html.length > 0;
    const hasPng = result !== undefined && result.pngBuffer.length > 0;
    // Precedence: ambiguous-window > not-renderable (including a missing
    // result or no output) > partial > clamped > complete. A partial capture
    // keeps its clamp offsets but never claims to show the complete final state.
    const fidelity: FrameCaptureFidelity = ambiguous
      ? 'ambiguous-window'
      : result === undefined || result.fidelity === 'not-renderable' || (!hasHtml && !hasPng)
        ? 'not-renderable'
        : result.fidelity === 'partial' || !hasHtml || !hasPng
          ? 'partial'
          : capture.requestedOffsetMs === undefined
            ? result.fidelity
            : 'clamped';
    return buildManifestCapture(capture, result, fidelity);
  });
  deduplicateConsecutiveCaptureFiles(prepared);
  // Warn on every capture that was not fully drawn, so none passes silently.
  // The not-renderable warning counts only captures carrying that label (a
  // partial capture can carry a renderer-supplied reason too); partial and
  // ambiguous-window captures each get one count line of their own.
  const undrawnByReason = new Map<string, number>();
  let partialCount = 0;
  let ambiguousCount = 0;
  for (const capture of prepared) {
    const { fidelity, reason } = capture.manifest;
    // Every not-renderable capture carries a reason (buildManifestCapture).
    if (fidelity === 'not-renderable' && reason !== undefined) {
      undrawnByReason.set(reason, (undrawnByReason.get(reason) ?? 0) + 1);
    } else if (fidelity === 'partial') {
      partialCount += 1;
    } else if (fidelity === 'ambiguous-window') {
      ambiguousCount += 1;
    }
  }
  if (ambiguousCount > 0) {
    warnings.push(
      `Warning: ${ambiguousCount} frame capture(s) were not drawn: this journey's time matched more than one recorded window, so the command could not tell which window to draw. They are marked ambiguous-window in manifest.json.`,
    );
  }
  for (const [reason, count] of undrawnByReason) {
    warnings.push(`Warning: couldn't draw ${count} frame capture(s), marked not-renderable in manifest.json: ${reason}`);
  }
  if (partialCount > 0) {
    warnings.push(`Warning: ${partialCount} frame capture(s) were only partly drawn and are marked partial in manifest.json.`);
  }

  const manifest: FramesManifest = {
    slug: options.slug,
    sessionId,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    renderer: FRAMES_RENDERER,
    planFingerprint,
    signatureSemanticsVersion: sidecar.source.signatureSemanticsVersion ?? null,
    exemplarOf: null,
    containsUserContent: true,
    handling: { localOnly: true, doNotCommit: true, agentUse: 'structure-not-people' },
    ...(sidecar.viewport === undefined ? {} : { viewport: sidecar.viewport }),
    captures: prepared.map(({ manifest: capture }) => capture),
    omitted: plan.omitted,
  };

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const writtenFiles = new Set<string>();
    for (const preparedCapture of prepared) {
      const capture = preparedCapture.manifest;
      if (capture.htmlFile !== undefined && preparedCapture.html !== undefined && !writtenFiles.has(capture.htmlFile)) {
        emitArtifact('frames-html', path.join(outputDir, capture.htmlFile), preparedCapture.html);
        writtenFiles.add(capture.htmlFile);
      }
      if (capture.pngFile !== undefined && preparedCapture.pngBuffer !== undefined && !writtenFiles.has(capture.pngFile)) {
        emitArtifact('frames-png', path.join(outputDir, capture.pngFile), preparedCapture.pngBuffer);
        writtenFiles.add(capture.pngFile);
      }
    }
    emitArtifact('frames-manifest', path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    emitArtifact('frames-agent-brief', path.join(outputDir, 'AGENT-BRIEF.md'), buildAgentBrief(options.slug, sessionId));
  } catch (error) {
    return {
      kind: 'refusal',
      message: `Frames could not write local artifacts: ${plainError(error)}.`,
      exitCode: 1,
      warnings,
    };
  }

  return { kind: 'written', manifest, outputDir, warnings };
}

/** Outcome coverage can appear on a signature-selected journey even when that journey was not plannable. */
export function frameOutcomeWarning(journey: Journey): string | undefined {
  if (journey.outcomeCoverage === undefined) return undefined;
  return journey.outcomeCoverage === 'not-captured' ? 'Outcome not captured.' : 'Outcome not recognized.';
}
