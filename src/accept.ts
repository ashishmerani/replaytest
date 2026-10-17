/**
 * `accept` — the living suite's explicit human gate. It promotes a reviewed
 * proposed plan (`<slug>.proposed.plan.json`) to the live plan pivot
 * (`<slug>.plan.json`), re-renders the live Markdown projection from that
 * JSON, and retires the consumed proposed Markdown/diff files by rename.
 *
 * SEAM GUARD: this module is pure local pipeline machinery. It
 * imports no provider adapter, performs no network calls, and only handles
 * provider-neutral sidecar JSON + rendered Markdown.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { emitArtifact } from './artifact-registry.js';
import { TOOL_NAME } from './cli/constants.js';
import { GENERATED_TESTS_DIR, RETIRED_DIR } from './cli/paths.js';
import { appendRetiredAwareness, isSlugRetired, readRetiredRecord, retiredDoorSentence, retirementRecoveryMessage, type RetiredRecord } from './cli/retired-awareness.js';
import { trailMentionSentence } from './retirement-evidence.js';
import { fidelityRegressionSummary, renderPlanMarkdown, type Sidecar, type SidecarSupersedes } from './sidecar.js';
import { parseSidecarJson, type JourneyChange } from './triage.js';
import { buildHandFinishedDisclosure } from './hand-finished.js';
import type { RefusalCodeForVerb } from './refusal-registry.js';
import { markSpecHashAccepted, specEmittedHashesPath } from './spec-emitted-hashes.js';
import { acquireStateLock, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, verifyStateLock, type StateLockHandle } from './state-lock.js';
import { createStatePublicationLedger, makeStateArtifactWriter, releaseStateLockWithDisclosure, type StateLockWarning, type StatePublicationLedger } from './state-writes.js';

export type AcceptRefusalCode = RefusalCodeForVerb<'accept'>;

export interface AcceptRefusal {
  kind: 'refusal';
  code: AcceptRefusalCode;
  message: string;
  exitCode: 1;
  warnings?: StateLockWarning[];
}

export interface AcceptResult {
  kind: 'accepted';
  slug: string;
  acceptedAt: string;
  forced: boolean;
  planJsonPath: string;
  markdownPath: string;
  retiredArtifactPaths: string[];
  nextCommand: string;
  driftStatus: string;
  supersedes: SidecarSupersedes;
  promotedSource: JourneyChange['next'];
  journeyChanged?: JourneyChange;
  fidelityRegressionSummary?: string;
  warnings?: StateLockWarning[];
}

export interface AcceptOptions {
  slug: string;
  plansDir: string;
  force?: boolean;
  confirmDifferentJourney?: boolean;
  workspaceRoot?: string;
  generatedTestsDir?: string;
  retiredDir?: string;
  now?: () => Date;
  /** Testable publication seam; production defaults remain artifact-registry + rename. */
  publishArtifact?: typeof emitArtifact;
  promoteFile?: typeof fs.renameSync;
  /** Testable acquisition seam for preserving thrown lock errors at acquire. */
  acquireStateLock?: typeof acquireStateLock;
  /** Loaded once at the command boundary; direct callers may inject the set. */
  handFinishedSlugs?: ReadonlySet<string>;
  stateLockHandle?: StateLockHandle;
  stealStateLock?: boolean;
  /** Lock progress uses stderr at the CLI boundary to preserve --json stdout. */
  progress?: (line: string) => void;
  /** Test seam: observes the persisted lease after acquisition. */
  onAcquired?: (handle: StateLockHandle) => void;
  log?: (line: string) => void;
  publicationLedger?: StatePublicationLedger;
}

interface AcceptPaths {
  liveJson: string;
  liveMarkdown: string;
  proposedJson: string;
  proposedMarkdown: string;
  proposedDiff: string;
}

interface ExistingLivePlan {
  exists: boolean;
  parsed?: Sidecar;
  invalidReason?: string;
}

interface AcceptancePreparation {
  live: ExistingLivePlan;
  proposed: Sidecar;
  journeyChanged?: JourneyChange;
  needsDifferentJourneyConsent: boolean;
}

/**
 * When the live plan carries an empty-search trail, this door names the
 * recorded state instead of handing back a bare loop-back. A customer who has
 * been searching fresh traffic for days should not land here and read "run
 * regenerate" as though nothing has been recorded. The count is the shared
 * qualifying count (`trailMentionSentence`), so this door and `regenerate`'s
 * own bar copy never report two different numbers for one trail.
 */
export function buildAcceptMissingProposalMessage(slug: string, proposedDisplayPath: string, trailSentence?: string): string {
  return (
    `No proposal found for "${slug}" at ${proposedDisplayPath}. ` +
    `${trailSentence === undefined ? '' : `${trailSentence} `}` +
    `Run \`${TOOL_NAME} heal --propose\`, \`${TOOL_NAME} triage ${slug} --propose\`, or \`${TOOL_NAME} regenerate ${slug}\` first.`
  );
}

/**
 * The retired-slug guard blocks a slug with no live plan from being promoted
 * as "the first live plan" — the retirement
 * record exists to prevent exactly that. The message names the retirement
 * date, the record path, the restore pointer, and the evidence basis, then
 * points at re-planning as the sanctioned fresh start.
 */
export function buildRetiredNoResurrectMessage(slug: string, record: RetiredRecord | undefined): string {
  const recordSentence = record === undefined
    ? `This journey was retired. Retirement record: .replaytest/retired/${slug}/retirement.json — see it for the reversal recipe.`
    : retiredDoorSentence(slug, record);
  return (
    `Refusing to accept "${slug}": ${recordSentence} ` +
    `Re-planning is the sanctioned fresh start — run \`${TOOL_NAME} plan <distinctId>\` to create a new live plan for this journey first, then accept.`
  );
}

export function buildAcceptLiveExistsMessage(
  slug: string,
  liveDisplayPath: string,
  journeyChanged?: JourneyChange,
  needsDifferentJourneyConsent = false,
): string {
  const base = `${liveDisplayPath} already exists for "${slug}" — refusing to overwrite the live plan. Pass --force to promote this proposal.`;
  return journeyChanged === undefined
    ? base
    : `${base} ${buildAcceptJourneyChangedPreview(slug, journeyChanged, needsDifferentJourneyConsent)}`;
}

/**
 * A damaged proposal has two exits and the refusal names both: repair the named
 * file by hand, or write a brand-new proposal over it. The two named commands
 * are the SAME pair `buildAcceptMissingProposalMessage` offers when a proposal
 * is missing entirely — one advice for "this workspace needs a proposal",
 * whether the file is absent or unreadable.
 */
export function buildAcceptInvalidProposalMessage(slug: string, reason: string, proposedDisplayPath: string): string {
  return (
    `Cannot accept proposal for "${slug}": invalid proposed plan JSON (${reason}). ` +
    `Fix ${proposedDisplayPath} by hand, or write a fresh proposal with ` +
    `\`${TOOL_NAME} triage ${slug} --propose\` or \`${TOOL_NAME} regenerate ${slug}\`.`
  );
}

/**
 * "Repair the live plan" named no way to do it. This names the file a hand
 * repair needs and the one command that genuinely rewrites it — `plan --force`,
 * the same overwrite route the invalid-sidecar refusal offers, applied to the
 * other file. Then it says to come back and re-run accept, so the reader is not
 * left holding a repaired plan and no next command.
 */
export function buildAcceptInvalidLivePlanMessage(slug: string, reason: string, liveDisplayPath: string): string {
  return (
    `Cannot verify whether accepting "${slug}" would replace a different journey: the live plan could not be parsed (${reason}). ` +
    `Fix ${liveDisplayPath} by hand, or overwrite it by re-planning the original session ` +
    `(\`${TOOL_NAME} plan <distinctId> --force\`) if you still have it, then re-run accept.`
  );
}

export function buildAcceptDifferentJourneyMessage(slug: string, journeyChanged: JourneyChange): string {
  return (
    `Refusing to accept "${slug}": this proposal is backed by a different recorded session. ` +
    `${formatJourneyChangedSources(journeyChanged)} Pass --confirm-different-journey only after reviewing that replacement. ` +
    `Re-run: \`${TOOL_NAME} accept ${slug} --force --confirm-different-journey\`.`
  );
}

function buildAcceptJourneyChangedPreview(slug: string, journeyChanged: JourneyChange, needsDifferentJourneyConsent: boolean): string {
  const confirmation = needsDifferentJourneyConsent
    ? ' This replacement needs two separate consents: overwrite the live plan and confirm the different journey.'
    : ' This replacement needs explicit overwrite consent.';
  const flags = needsDifferentJourneyConsent ? ' --force --confirm-different-journey' : ' --force';
  return (
    `${formatJourneyChangedSources(journeyChanged)}${confirmation} ` +
    `Re-run: \`${TOOL_NAME} accept ${slug}${flags}\`.`
  );
}

function formatJourneyChangedSources(journeyChanged: JourneyChange): string {
  return `Source recording changes from ${formatSourceIdentity(journeyChanged.previous)} to ${formatSourceIdentity(journeyChanged.next)}.`;
}

function formatSourceIdentity(source: {
  sessionId?: string;
  distinctId?: string;
  signature?: string;
}): string {
  return `session ${source.sessionId ?? '(no recorded session ID)'} (distinct ID ${source.distinctId ?? '(no recorded distinct ID)'}; signature ${source.signature ?? '(no recorded signature)'})`;
}

export function buildAcceptNextCommand(slug: string, handFinishedDeclared = false): string {
  if (handFinishedDeclared) return buildHandFinishedDisclosure(slug);
  return `If tests/generated/${slug}.spec.ts has no hand edits, run \`${TOOL_NAME} scaffold ${slug} --force\`; otherwise apply the reviewed delta yourself.`;
}

export function buildAcceptDriftSafetyNet(slug: string, handFinishedDeclared = false): string {
  if (handFinishedDeclared) {
    return `Plan/spec status: heal, suite-status, and preflight compare substantive content for "${slug}". ${buildHandFinishedDisclosure(slug)}`;
  }
  return (
    `Plan/spec status: heal, suite-status, and preflight compare substantive content for "${slug}". ` +
    `An untouched machine spec will show confident drift after a plan change; a hand-edited spec is reported as unverified, ` +
    `except that this accepted plan is recorded as accepted-unverified. Run \`${TOOL_NAME} scaffold ${slug} --force\` only when overwriting the spec is intended.`
  );
}

export function formatAcceptResult(result: AcceptResult): string {
  return [
    `Accepted ${result.slug}.`,
    ...(result.fidelityRegressionSummary === undefined ? [] : [result.fidelityRegressionSummary]),
    ...(result.journeyChanged === undefined
      ? []
      : ['This test is now backed by a different recording.']),
    ...(result.journeyChanged === undefined || result.supersedes.previous === undefined
      ? []
      : [
          `Supersedes source recording: was ${formatSourceIdentity(result.supersedes.previous)} → now ${formatSourceIdentity(result.promotedSource)}.`,
        ]),
    `Wrote ${result.planJsonPath}`,
    `Wrote ${result.markdownPath}`,
    ...result.retiredArtifactPaths.map((p) => `Retired artifact -> ${p}`),
    result.driftStatus,
    `Next: ${result.nextCommand}`,
  ].join('\n');
}

export function formatAcceptJson(result: AcceptResult): string {
  const { warnings, ...accepted } = result;
  return `${JSON.stringify({ accepted, ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }) }, null, 2)}\n`;
}

export function formatAcceptRefusalJson(refusal: AcceptRefusal): string {
  return `${JSON.stringify({ error: { code: refusal.code, message: refusal.message } }, null, 2)}\n`;
}

export function renderAcceptRefusal(refusal: AcceptRefusal): string {
  return refusal.message;
}

function archiveForcedLivePlan(
  shouldArchive: boolean,
  paths: AcceptPaths,
  acceptedAt: string,
  workspaceRoot: string,
): string[] {
  return shouldArchive ? archiveExistingLive(paths, acceptedAt, workspaceRoot) : [];
}

function publishAcceptedProposal(
  opts: AcceptOptions,
  paths: AcceptPaths,
  workspaceRoot: string,
  acceptedSidecar: Sidecar,
  acceptedAt: string,
  preparation: AcceptancePreparation,
  handFinishedDeclared: boolean,
  supersedes: SidecarSupersedes,
  retired: string[],
): AcceptResult | AcceptRefusal {
  const writeRecovery = retirementRecoveryMessage(opts.slug, opts.retiredDir ?? RETIRED_DIR);
  if (writeRecovery !== undefined) return { kind: 'refusal', code: 'retirement-recovery-required', message: writeRecovery, exitCode: 1 };
  const publishArtifact = opts.publishArtifact ?? emitArtifact;
  const promoteFile = opts.promoteFile ?? fs.renameSync;
  if (opts.stateLockHandle !== undefined) verifyStateLock(opts.stateLockHandle);
  publishArtifact('plan-json', paths.proposedJson, `${JSON.stringify(acceptedSidecar, null, 2)}\n`);
  promoteFile(paths.proposedJson, paths.liveJson);
  if (opts.stateLockHandle !== undefined) verifyStateLock(opts.stateLockHandle);
  emitArtifact('plan-md', paths.liveMarkdown, `${renderPlanMarkdown(acceptedSidecar)}\n`);
  retired.push(...retireProposalCompanions(paths, acceptedAt, workspaceRoot));
  // Accept changes the plan pivot but never writes the generated spec. Keep a
  // pre-existing hash baseline intact so a hand edit remains visible to the
  // next repair loop; marker-less legacy specs deliberately stay unknown.
  markSpecHashAccepted(
    specEmittedHashesPath(workspaceRoot),
    workspaceRoot,
    opts.slug,
    path.join(opts.generatedTestsDir ?? GENERATED_TESTS_DIR, `${opts.slug}.spec.ts`),
    acceptedSidecar,
    acceptedAt,
    makeStateArtifactWriter({ stateLockHandle: opts.stateLockHandle, publicationLedger: opts.publicationLedger }),
  );
  const fidelitySummary = fidelityRegressionSummary(acceptedSidecar);
  return {
    kind: 'accepted',
    slug: opts.slug,
    acceptedAt,
    forced: opts.force ?? false,
    planJsonPath: toDisplayPath(paths.liveJson, workspaceRoot),
    markdownPath: toDisplayPath(paths.liveMarkdown, workspaceRoot),
    retiredArtifactPaths: retired,
    nextCommand: buildAcceptNextCommand(opts.slug, handFinishedDeclared),
    driftStatus: buildAcceptDriftSafetyNet(opts.slug, handFinishedDeclared),
    supersedes,
    promotedSource: journeySource(preparation.proposed),
    ...(preparation.journeyChanged === undefined ? {} : { journeyChanged: preparation.journeyChanged }),
    ...(fidelitySummary === undefined ? {} : { fidelityRegressionSummary: fidelitySummary }),
  };
}

function completeAcceptance(
  opts: AcceptOptions,
  paths: AcceptPaths,
  workspaceRoot: string,
  acceptedSidecar: Sidecar,
  acceptedAt: string,
  preparation: AcceptancePreparation,
  handFinishedDeclared: boolean,
  supersedes: SidecarSupersedes,
): AcceptResult | AcceptRefusal {
  const recovery = retirementRecoveryMessage(opts.slug, opts.retiredDir ?? RETIRED_DIR);
  if (recovery !== undefined) return { kind: 'refusal', code: 'retirement-recovery-required', message: recovery, exitCode: 1 };
  fs.mkdirSync(opts.plansDir, { recursive: true });
  const retired = archiveForcedLivePlan(preparation.live.exists && opts.force === true, paths, acceptedAt, workspaceRoot);
  return publishAcceptedProposal(opts, paths, workspaceRoot, acceptedSidecar, acceptedAt, preparation, handFinishedDeclared, supersedes, retired);
}

function translateAcceptLockError(error: unknown, phase: 'acquire' | 'work'): AcceptRefusal | undefined {
  if (phase === 'acquire' && error instanceof StateLockHeldError) {
    return { kind: 'refusal', code: 'state-lock-held', message: stateLockHeldMessage('accept', error.info, error.deadHolder), exitCode: 1 };
  }
  if (phase === 'work' && error instanceof StateLockFencedError) {
    return { kind: 'refusal', code: 'state-lock-fenced', message: stateLockFencedMessage('accept'), exitCode: 1 };
  }
  return undefined;
}

function withAcceptStateLock(opts: AcceptOptions): AcceptResult | AcceptRefusal {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  let handle: StateLockHandle;
  const publicationLedger = opts.publicationLedger ?? createStatePublicationLedger();
  let result: AcceptResult | AcceptRefusal | undefined;
  try {
    const acquire = opts.acquireStateLock ?? acquireStateLock;
    handle = acquire(path.join(workspaceRoot, '.replaytest', 'state'), 'accept', { onProgress: opts.progress ?? opts.log, onAcquired: opts.onAcquired }, opts.stealStateLock === true);
  } catch (error) {
    const refusal = translateAcceptLockError(error, 'acquire');
    if (refusal !== undefined) return refusal;
    throw error;
  }
  try {
    result = acceptProposal({ ...opts, stateLockHandle: handle, publicationLedger });
    return result;
  } catch (error) {
    const refusal = translateAcceptLockError(error, 'work');
    if (refusal !== undefined) {
      result = refusal;
      return result;
    }
    throw error;
  } finally {
    releaseStateLockWithDisclosure(handle, publicationLedger, 'accept', opts.progress ?? opts.log);
    if (result !== undefined && publicationLedger.warnings.length > 0) result.warnings = publicationLedger.warnings;
  }
}

export function acceptProposal(opts: AcceptOptions): AcceptResult | AcceptRefusal {
  if (opts.stateLockHandle === undefined) return withAcceptStateLock(opts);
  return acceptProposalWithHandle(opts);
}

function acceptProposalWithHandle(opts: AcceptOptions): AcceptResult | AcceptRefusal {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const handFinishedSlugs = opts.handFinishedSlugs ?? new Set<string>();
  const handFinishedDeclared = handFinishedSlugs.has(opts.slug);
  const acceptedAt = (opts.now ?? (() => new Date()))().toISOString();
  const paths = acceptPaths(opts.plansDir, opts.slug);

  if (!fs.existsSync(paths.proposedJson)) {
    // Read the live plan only for its trail. A missing or unparseable live plan
    // simply yields no trail sentence — this refusal is about the PROPOSAL, and
    // it must not turn into a live-plan diagnosis.
    const trailSentence = trailMentionSentence(readExistingLivePlan(paths.liveJson).parsed);
    return {
      kind: 'refusal',
      code: 'missing-proposal',
      message: appendRetiredAwareness(
        opts.slug,
        buildAcceptMissingProposalMessage(opts.slug, toDisplayPath(paths.proposedJson, workspaceRoot), trailSentence),
        opts.retiredDir ?? RETIRED_DIR,
      ),
      exitCode: 1,
    };
  }

  // A retired slug with no live plan must not be silently resurrected.
  const resurrectRefusal = retiredNoResurrectRefusal(opts, paths);
  if (resurrectRefusal !== undefined) return resurrectRefusal;

  const preparation = prepareAcceptance(paths, opts, workspaceRoot);
  if ('kind' in preparation) return preparation;

  const consentRefusal = refusalForMissingConsent(
    opts,
    paths,
    workspaceRoot,
    preparation.journeyChanged,
    preparation.needsDifferentJourneyConsent,
  );
  if (consentRefusal !== undefined) return consentRefusal;

  const supersedes = buildSupersedes(opts.slug, acceptedAt, preparation.live);
  const acceptedSidecar: Sidecar = {
    ...preparation.proposed,
    source: {
      ...preparation.proposed.source,
      acceptedAt,
      supersedes,
    },
  };

  return completeAcceptance(opts, paths, workspaceRoot, acceptedSidecar, acceptedAt, preparation, handFinishedDeclared, supersedes);
}

/**
 * The retired-slug guard: a retired slug with no live plan must not be
 * promoted as "the first live plan" — the retirement record exists to prevent
 * exactly that. Re-planning IS the sanctioned fresh start, but re-planning
 * creates a LIVE plan first; this guard fires only when no live plan exists
 * alongside the retired folder.
 */
function retiredNoResurrectRefusal(opts: AcceptOptions, paths: AcceptPaths): AcceptRefusal | undefined {
  if (!isSlugRetired(opts.slug, opts.retiredDir ?? RETIRED_DIR) || fs.existsSync(paths.liveJson)) return undefined;
  const record = readRetiredRecord(opts.slug, opts.retiredDir ?? RETIRED_DIR);
  return {
    kind: 'refusal',
    code: 'retired-no-resurrect',
    message: buildRetiredNoResurrectMessage(opts.slug, record),
    exitCode: 1,
  };
}

function prepareAcceptance(paths: AcceptPaths, opts: AcceptOptions, workspaceRoot: string): AcceptancePreparation | AcceptRefusal {
  const live = readExistingLivePlan(paths.liveJson);
  const proposedParsed = parseSidecarJson(fs.readFileSync(paths.proposedJson, 'utf8'));
  if (proposedParsed.kind === 'invalid') {
    return {
      kind: 'refusal',
      code: 'invalid-proposal',
      message: buildAcceptInvalidProposalMessage(opts.slug, proposedParsed.reason, toDisplayPath(paths.proposedJson, workspaceRoot)),
      exitCode: 1,
    };
  }

  if (live.exists && live.parsed === undefined) {
    return {
      kind: 'refusal',
      code: 'invalid-live-plan',
      message: buildAcceptInvalidLivePlanMessage(
        opts.slug,
        live.invalidReason ?? 'unknown reason',
        toDisplayPath(paths.liveJson, workspaceRoot),
      ),
      exitCode: 1,
    };
  }

  const needsDifferentJourneyConsent = live.parsed !== undefined && differentJourney(live.parsed, proposedParsed.sidecar);
  const journeyChanged =
    live.parsed !== undefined && (recordingChanged(live.parsed, proposedParsed.sidecar) || needsDifferentJourneyConsent)
      ? buildJourneyChange(live.parsed, proposedParsed.sidecar)
      : undefined;
  return {
    live,
    proposed: proposedParsed.sidecar,
    needsDifferentJourneyConsent,
    ...(journeyChanged === undefined ? {} : { journeyChanged }),
  };
}

function refusalForMissingConsent(
  opts: AcceptOptions,
  paths: AcceptPaths,
  workspaceRoot: string,
  journeyChanged: JourneyChange | undefined,
  needsDifferentJourneyConsent: boolean,
): AcceptRefusal | undefined {
  if (fs.existsSync(paths.liveJson) && !opts.force) {
    return {
      kind: 'refusal',
      code: 'live-plan-exists',
      message: buildAcceptLiveExistsMessage(
        opts.slug,
        toDisplayPath(paths.liveJson, workspaceRoot),
        journeyChanged,
        needsDifferentJourneyConsent,
      ),
      exitCode: 1,
    };
  }

  if (needsDifferentJourneyConsent && !opts.confirmDifferentJourney) {
    return {
      kind: 'refusal',
      code: 'different-journey',
      // `prepareAcceptance` builds this for either predicate that can require
      // consent: changed backing recording or changed regenerate signature.
      message: buildAcceptDifferentJourneyMessage(opts.slug, journeyChanged!),
      exitCode: 1,
    };
  }

  return undefined;
}

/**
 * The ordinary propose/accept path remains session-id keyed by design. Only a
 * proposal stamped by `regenerate` takes the path-scoped signature check: a
 * same-signature fresh recording is the same journey; a successor signature
 * still needs the different-journey rail.
 */
function differentJourney(live: Sidecar, proposed: Sidecar): boolean {
  if (proposed.source.regeneration?.kind === 'regenerate') {
    const liveSignature = live.source.signature?.trim();
    const proposedSignature = proposed.source.signature?.trim();
    return liveSignature === undefined || liveSignature.length === 0 || proposedSignature === undefined || proposedSignature.length === 0 || liveSignature !== proposedSignature;
  }
  return live.source.sessionId !== proposed.source.sessionId;
}

function recordingChanged(live: Sidecar, proposed: Sidecar): boolean {
  return live.source.sessionId !== proposed.source.sessionId;
}

function journeySource(sidecar: Sidecar): JourneyChange['next'] {
  return {
    distinctId: sidecar.source.distinctId,
    sessionId: sidecar.source.sessionId,
    ...(sidecar.source.signature === undefined ? {} : { signature: sidecar.source.signature }),
    finalUrl: sidecar.assertions.find((assertion) => assertion.type === 'final-url')?.value ?? null,
  };
}

function buildJourneyChange(live: Sidecar, proposed: Sidecar): JourneyChange {
  return { previous: journeySource(live), next: journeySource(proposed) };
}

function acceptPaths(plansDir: string, slug: string): AcceptPaths {
  return {
    liveJson: path.join(plansDir, `${slug}.plan.json`),
    liveMarkdown: path.join(plansDir, `${slug}.md`),
    proposedJson: path.join(plansDir, `${slug}.proposed.plan.json`),
    proposedMarkdown: path.join(plansDir, `${slug}.proposed.md`),
    proposedDiff: path.join(plansDir, `${slug}.proposed.diff.md`),
  };
}

function readExistingLivePlan(liveJsonPath: string): ExistingLivePlan {
  if (!fs.existsSync(liveJsonPath)) return { exists: false };
  try {
    const parsed = parseSidecarJson(fs.readFileSync(liveJsonPath, 'utf8'));
    return parsed.kind === 'sidecar'
      ? { exists: true, parsed: parsed.sidecar }
      : { exists: true, invalidReason: parsed.reason };
  } catch (err) {
    return { exists: true, invalidReason: err instanceof Error ? err.message : String(err) };
  }
}

function buildSupersedes(slug: string, acceptedAt: string, live: ExistingLivePlan): SidecarSupersedes {
  if (!live.exists) {
    return {
      supersededAt: acceptedAt,
      note: `No previous live plan for "${slug}"; this accepted proposal became the first live plan.`,
    };
  }

  if (live.parsed === undefined) {
    return {
      supersededAt: acceptedAt,
      note: `Previous live plan for "${slug}" existed but could not be parsed (${live.invalidReason ?? 'unknown reason'}); it was superseded by this accepted proposal.`,
    };
  }

  return {
    supersededAt: acceptedAt,
    note:
      `Supersedes previous live plan "${slug}" generated at ${live.parsed.source.generatedAt}` +
      `${live.parsed.source.acceptedAt === undefined ? '' : ` and accepted at ${live.parsed.source.acceptedAt}`}.`,
    previous: {
      title: live.parsed.title,
      generatedAt: live.parsed.source.generatedAt,
      acceptedAt: live.parsed.source.acceptedAt,
      distinctId: live.parsed.source.distinctId,
      sessionId: live.parsed.source.sessionId,
      journeyIndex: live.parsed.source.journeyIndex,
      signature: live.parsed.source.signature,
    },
  };
}

function archiveExistingLive(paths: AcceptPaths, acceptedAt: string, workspaceRoot: string): string[] {
  const archived: string[] = [];
  const stem = archiveStem(paths.liveJson, acceptedAt, 'superseded-live');
  const jsonArchive = renameIfExists(paths.liveJson, `${stem}.json`, workspaceRoot);
  if (jsonArchive !== undefined) archived.push(jsonArchive);
  const markdownArchive = renameIfExists(paths.liveMarkdown, `${stem}.md`, workspaceRoot);
  if (markdownArchive !== undefined) archived.push(markdownArchive);
  return archived;
}

function retireProposalCompanions(paths: AcceptPaths, acceptedAt: string, workspaceRoot: string): string[] {
  const archived: string[] = [];
  const stem = archiveStem(paths.liveJson, acceptedAt, 'accepted-proposal');
  const proposedMarkdownArchive = renameIfExists(paths.proposedMarkdown, `${stem}.md`, workspaceRoot);
  if (proposedMarkdownArchive !== undefined) archived.push(proposedMarkdownArchive);
  const proposedDiffArchive = renameIfExists(paths.proposedDiff, `${stem}.diff.md`, workspaceRoot);
  if (proposedDiffArchive !== undefined) archived.push(proposedDiffArchive);
  return archived;
}

function archiveStem(liveJsonPath: string, acceptedAt: string, label: string): string {
  const dir = path.dirname(liveJsonPath);
  const slug = path.basename(liveJsonPath).replace(/\.plan\.json$/, '');
  return path.join(dir, `${slug}.${label}.${safeTimestamp(acceptedAt)}`);
}

function safeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function renameIfExists(source: string, requestedTarget: string, workspaceRoot: string): string | undefined {
  if (!fs.existsSync(source)) return undefined;
  const target = uniquePath(requestedTarget);
  fs.renameSync(source, target);
  return toDisplayPath(target, workspaceRoot);
}

function uniquePath(requested: string): string {
  if (!fs.existsSync(requested)) return requested;
  const ext = path.extname(requested);
  const base = requested.slice(0, -ext.length);
  let suffix = 2;
  while (fs.existsSync(`${base}-${suffix}${ext}`)) suffix += 1;
  return `${base}-${suffix}${ext}`;
}

function toDisplayPath(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}
