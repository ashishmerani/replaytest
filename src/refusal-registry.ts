/* eslint-disable max-lines -- this table is the canonical refusal registry. */

/**
 * Canonical, provider-neutral catalog of public refusal codes.
 *
 * A code is immutable once it ships: retain its namespaced code forever, mark
 * any later retirement in its row, and never reuse it for another situation.
 * This module intentionally imports no command implementation (and therefore
 * no provider adapter). Command modules derive their public code unions from
 * this table, while `explain` reads the same rows locally without a network or
 * workspace read. The two runtime string-only `retire` sites for an unknown
 * flag and a missing slug remain candidates for a later copy pass; this catalog neither
 * changes their behavior nor invents registry rows for them. The registry
 * must never import coarse-store constants: coarse-store may import this leaf,
 * but the reverse edge would create the future-cycle trap.
 */

export type RefusalContentStatus = 'explained' | 'message-only';

export const COARSE_STORE_LOCK_CASES = ['live', 'dead', 'aged', 'malformed', 'legacy', 'swept-claim'] as const;
export type CoarseStoreLockCase = typeof COARSE_STORE_LOCK_CASES[number];

/** How a command exposes the code that this entry describes. */
export type RefusalEvidenceClass = 'emitted-code' | 'state-member' | 'message-only';

/** The inventory's encoding tier, retained so agents can judge code visibility. */
export type RefusalTier = 'A' | 'B' | 'C' | 'internal';

export interface RefusalNextStep {
  description: string;
  command?: string;
}

export interface RefusalOverride {
  flags: readonly string[];
  /** What the operator is explicitly consenting to by using every listed flag. */
  consentSemantics: string;
  /** Facts to check before supplying the override. */
  preconditions: readonly string[];
}

export interface RefusalCase {
  /** A distinct runtime situation that currently shares this public code. */
  description: string;
  /** The verbatim refusal template the command prints for this situation. */
  message: string;
  /** Overrides the entry-level exit code when this situation is warning-only. */
  exitCode?: number;
}

export interface RefusalRegistryEntry {
  verb: string;
  code: string;
  contentStatus: RefusalContentStatus;
  /** The verbatim refusal template the command prints for this code. */
  message: string;
  meaning: string;
  evidenceClass: RefusalEvidenceClass;
  jsonVisible: boolean;
  exitCode: number;
  tier: RefusalTier;
  cases: readonly RefusalCase[];
  override: RefusalOverride | null;
  nextSteps: readonly RefusalNextStep[];
}

const noOverride = null;

function stateLockHeldCases(verb: string): readonly RefusalCase[] {
  const retireSuffix = verb === 'retire'
    ? ' If both retire locks are held by dead owners, recover them with replaytest retire {{slug}} --recover-crashed-locks. Granular form: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock.'
    : '';
  const cases: RefusalCase[] = [
    {
      description: 'Another state-writing verb owns the shared lease.',
      message: `state-lock-held: ${verb} refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.${retireSuffix}`,
    },
    {
      description: 'The recorded holder is dead beyond the recovery grace window.',
      message: `state-lock-held: ${verb} refused because the state lock at .replaytest/state/.state-lock is held by a dead process beyond the recovery grace window. Inspect the lock, then retry ${verb} with --steal-state-lock only after confirming no writer is alive.${retireSuffix}`,
    },
    {
      description: 'The state-lock payload is malformed and has no verifiable owner.',
      message: `state-lock-held: ${verb} refused because .replaytest/state/.state-lock is malformed and has no verifiable owner. Inspect or remove the malformed lock, then retry ${verb} with --steal-state-lock only after confirming no writer is alive.${verb === 'retire' ? ' Granular form required: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock. The single --recover-crashed-locks flag does not apply because the state lock is malformed and has no verifiable owner.' : ''}`,
    },
    {
      description: 'An explicit state-lock steal was denied by filesystem permissions.',
      message: `state-lock-held: ${verb} could not take --steal-state-lock because permission to release .replaytest/state/.state-lock was denied ({{permissionCode}}). Check filesystem permissions, then retry after confirming no writer is alive.${retireSuffix}`,
    },
  ];
  if (verb === 'retire') {
    cases.push({
      description: 'The recorded holder is dead but still inside the recovery grace window.',
      message: `state-lock-held: retire refused because the dead state-lock holder at .replaytest/state/.state-lock is still inside its recovery grace window. Retry after the grace window, or use --steal-state-lock only when you accept that the dead holder's in-flight write may still land over recent state. Granular form required: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock. The single --recover-crashed-locks flag does not apply while the dead state-lock holder is still inside its recovery grace window.`,
    });
  }
  return cases;
}

function stateLockReleasedLateEntry<const Verb extends string>(verb: Verb, jsonVisible: boolean) {
  const message = `state-lock-released-late: the shared write lock changed while ${verb} was finishing. ${verb} saved {{files}}; those files may differ from what ${verb} produced. Check them before relying on them, then re-run ${verb} if needed.`;
  return {
    verb,
    code: 'state-lock-released-late',
    contentStatus: 'explained',
    message,
    meaning: `${verb} published shared state before its write-lock lease changed during release.`,
    evidenceClass: jsonVisible ? 'emitted-code' : 'message-only',
    jsonVisible,
    exitCode: 0,
    tier: 'A',
    cases: [{ description: 'The shared write-lock lease changed after a state publication and before release completed.', message, exitCode: 0 }],
    override: noOverride,
    nextSteps: [{ description: 'Check the named shared state files, then re-run if needed.' }],
  } as const;
}

export type CoarseStoreLockAdviceCase = CoarseStoreLockCase;

const COARSE_STORE_LOCK_SUCCESSOR_WINDOW =
  'The previous scan may land one already-verified write after the steal — one slice window may briefly hold its data.';
// The same sentence spliced MID-sentence (after "accept that ") — one source of bytes, presentation-only
// case change; the splice must stay lowercase across the `explain` surfaces.
const COARSE_STORE_LOCK_SUCCESSOR_WINDOW_MIDSENTENCE =
  COARSE_STORE_LOCK_SUCCESSOR_WINDOW.charAt(0).toLowerCase() + COARSE_STORE_LOCK_SUCCESSOR_WINDOW.slice(1);
const COARSE_STORE_LOCK_LEGACY_DISCLOSURE =
  'The displaced scan can keep writing after the lock is stolen — its writes are not bounded to one window. Treat the store as possibly mixed until the next full scan.';

/**
 * The one per-case advice source shared by runtime refusals and explain's
 * catalog. It deliberately returns only the advice clause; callers own the
 * situation, progress, lock-free escapes, and any later-phase suffix.
 */
export function coarseStoreLockAdviceClause(
  lockCase: CoarseStoreLockAdviceCase,
  verb: string,
): string {
  const command = `${verb} --steal-scan-lock`;
  switch (lockCase) {
    case 'live':
      return `Retry after it completes, or pass --steal-scan-lock only after reviewing the in-flight scan cost. ${COARSE_STORE_LOCK_SUCCESSOR_WINDOW}`;
    case 'dead':
      return `Retry with ${command} only after confirming no scan is alive.`;
    case 'aged':
      return `Recovery is ${command}; it discards the unsaved in-flight scan. ${COARSE_STORE_LOCK_SUCCESSOR_WINDOW}`;
    case 'malformed':
      return `Inspect it, then use ${command} only after confirming no scan is alive.`;
    case 'legacy':
      return `Use ${command} only with explicit recovery consent. ${COARSE_STORE_LOCK_LEGACY_DISCLOSURE}`;
    case 'swept-claim':
      return 'Nothing was published, so --steal-scan-lock cannot help. Simply retry.';
  }
}

export function coarseStoreLockCases(verb: string): readonly RefusalCase[] {
  const laterStateLease = verb === 'triage' || verb === 'heal' || verb === 'sessions'
    ? ' A later phase may separately contend the state lease.'
    : '';
  return [
    {
      description: 'A live coarse scan owns the store.',
      message: `coarse-store-lock-held: ${verb} refused coarse-store lock contention: another scan owns .replaytest/cache/coarse-store/store.lock. ${coarseStoreLockAdviceClause('live', verb)} Lock-free escapes are gaps --stored and scan-status; multiple waiters have no fairness guarantee.${laterStateLease}`,
    },
    {
      description: 'A new-format owner is provably dead.',
      message: `coarse-store-lock-held: ${verb} found a dead coarse-store owner. ${coarseStoreLockAdviceClause('dead', verb)}${laterStateLease}`,
    },
    {
      description: 'The owner looks alive but its generation-matched heartbeat is beyond the reclaim bound.',
      message: `coarse-store-lock-held: ${verb} found an aged coarse-store heartbeat. ${coarseStoreLockAdviceClause('aged', verb)}${laterStateLease}`,
    },
    {
      description: 'The published lock payload is malformed beyond the settle window.',
      message: `coarse-store-lock-held: ${verb} found a malformed coarse-store lock with no verifiable owner. ${coarseStoreLockAdviceClause('malformed', verb)}${laterStateLease}`,
    },
    {
      description: 'The lock uses the legacy acquiredAt payload.',
      message: `coarse-store-lock-held: ${verb} found a legacy coarse-store payload. It is never stolen by parsing alone. ${coarseStoreLockAdviceClause('legacy', verb)}${laterStateLease}`,
    },
    {
      description: 'Another local scan swept this process\'s private publication claim before the lock was published; simply retry because --steal-scan-lock cannot help.',
      message: `coarse-store-lock-held: ${verb} could not publish a coarse-store lock because another local scan swept this process's private claim while it was publishing; this is contention, not a broken store. ${coarseStoreLockAdviceClause('swept-claim', verb)}${laterStateLease}`,
    },
  ];
}

function coarseStoreLockOverride(): RefusalOverride {
  return {
    flags: ['--steal-scan-lock'],
    consentSemantics: `Explicitly discard a possibly in-flight coarse scan and accept the unsaved work and final-write race cost. For a live or aged holder, accept that ${COARSE_STORE_LOCK_SUCCESSOR_WINDOW_MIDSENTENCE}`,
    preconditions: ['Confirm the existing scan is not a live scan you want to keep.', `For a live or aged holder, inspect the holder and accept that ${COARSE_STORE_LOCK_SUCCESSOR_WINDOW_MIDSENTENCE}`],
  };
}

const COARSE_STORE_LOCK_NEXT_STEP =
  'Retry after the coarse scan completes, or deliberately recover it with --steal-scan-lock.';

/**
 * The bounded catalog. `{{placeholder}}` marks one runtime interpolation
 * value, never customer-visible prose; its name identifies the value or
 * conditional expression exactly where the production constructor inserts it.
 * All text outside a placeholder is byte-identical to command output. The
 * message-only floor remains a catalog row rather than a missing lookup: a
 * code already visible in command JSON must never send an agent to an
 * unrelated bare-code candidate.
 */
export const REFUSAL_REGISTRY = [
  stateLockReleasedLateEntry('accept', true),
  stateLockReleasedLateEntry('heal', true),
  stateLockReleasedLateEntry('retire', true),
  stateLockReleasedLateEntry('triage', true),
  stateLockReleasedLateEntry('suite-health', true),
  stateLockReleasedLateEntry('fix-selector', false),
  stateLockReleasedLateEntry('scaffold', false),
  stateLockReleasedLateEntry('sessions', false),
  {
    verb: 'auth-setup',
    code: 'privacy-disclosure-required',
    contentStatus: 'explained',
    message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.',
    meaning: 'Auth setup refuses to write a carrier-bearing artifact until the operator explicitly reviews and consents for this invocation.',
    evidenceClass: 'message-only',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The structured auth setup artifact contains a PII-shaped value.', message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.' }],
    override: { flags: ['--allow-privacy-disclosure'], consentSemantics: 'Publish the reviewed PII-shaped auth artifact for this invocation only.', preconditions: ['Review the named structured findings before accepting the write.'] },
    nextSteps: [{ description: 'Review the findings, then repeat with per-invocation consent.', command: 'replaytest auth-setup --allow-privacy-disclosure' }],
  },
  {
    verb: 'fix-selector',
    code: 'privacy-disclosure-required',
    contentStatus: 'explained',
    message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.',
    meaning: 'Selector repair refuses to commit a PII-shaped locator without per-invocation review and consent.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A persisted selector replacement or prior locator is PII-shaped.', message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.' }],
    override: { flags: ['--allow-privacy-disclosure'], consentSemantics: 'Publish the reviewed PII-shaped selector patch for this invocation only.', preconditions: ['Review the redacted structured findings before accepting the patch.'] },
    nextSteps: [{ description: 'Review the findings, then repeat with per-invocation consent.', command: 'replaytest fix-selector <slug> --apply --allow-privacy-disclosure' }],
  },
  {
    verb: 'fix-selector',
    code: 'fix-selector-spec-scan-capped',
    contentStatus: 'explained',
    message: 'Cannot repair "{{slug}}": the relocated-spec scan stopped at the suite-scan budget ({{cappedBy}}) without a decision. Pass the spec path explicitly or restore it to the default path.',
    meaning: 'Selector repair could not safely decide whether a relocated spec is unique before the shared suite-scan budget was exhausted.',
    evidenceClass: 'message-only',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The shared file or directory budget was exhausted before relocation discovery completed.', message: 'Cannot repair "{{slug}}": the relocated-spec scan stopped at the suite-scan budget ({{cappedBy}}) without a decision. Pass the spec path explicitly or restore it to the default path.' }],
    override: noOverride,
    nextSteps: [{ description: 'Pass the intended spec path explicitly, or restore the spec to its default generated path.' }],
  },
  {
    verb: 'fix-selector',
    code: 'fix-selector-spec-ambiguous',
    contentStatus: 'explained',
    message: 'Cannot repair "{{slug}}": {{count}} generated specs carry its slug header: {{firstPath}}, {{secondPath}}. Pass the spec path explicitly or restore exactly one copy to the default path.',
    meaning: 'Selector repair found more than one generated spec claiming the requested slug and will not guess which file to edit.',
    evidenceClass: 'message-only',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'Two or more generated specs carry the same requested slug header.', message: 'Cannot repair "{{slug}}": {{count}} generated specs carry its slug header: {{firstPath}}, {{secondPath}}. Pass the spec path explicitly or restore exactly one copy to the default path.' }],
    override: noOverride,
    nextSteps: [{ description: 'Pass the intended spec path explicitly, or leave exactly one generated spec carrying the requested slug header.' }],
  },
  {
    verb: 'plan',
    code: 'privacy-disclosure-required',
    contentStatus: 'explained',
    message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.',
    meaning: 'Plan refuses a route-derived target path whose surviving URL segment is PII-shaped without per-invocation review and consent.',
    evidenceClass: 'message-only',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A surviving pre-slugification route segment is PII-shaped.', message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.' }],
    override: { flags: ['--allow-privacy-disclosure'], consentSemantics: 'Publish the reviewed PII-shaped route-derived target for this invocation only.', preconditions: ['Review the route segment and the attached disclosure before accepting the plan write.'] },
    nextSteps: [{ description: 'Review the route-derived target, then repeat with per-invocation consent.', command: 'replaytest plan <distinctId> --allow-privacy-disclosure' }],
  },
  {
    verb: 'retire',
    code: 'privacy-workspace-not-ignored',
    contentStatus: 'explained',
    message: 'privacy-workspace-not-ignored: the .replaytest/retired/ destination is not covered by Git ignore rules; local privacy state may be committed. Pass --allow-privacy-disclosure for this invocation only when you accept that.',
    meaning: 'This code has two roles: retirement refuses with exit code 1 when consent is absent, while plan and consented retirement emit a warning and continue.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [
      {
        description: 'Retirement without per-invocation consent refuses with exit code 1 when the archive destination is not covered by Git ignore rules.',
        message: 'privacy-workspace-not-ignored: the .replaytest/retired/ destination is not covered by Git ignore rules; local privacy state may be committed. Pass --allow-privacy-disclosure for this invocation only when you accept that.',
        exitCode: 1,
      },
      {
        description: 'Plan, and retirement with per-invocation consent, emit a non-refusing warning and continue when their destination is not Git-ignored.',
        message: 'privacy-workspace-not-ignored: {{displayPath}} is not git-ignored; local privacy state may be committed. Add {{displayPath}} to .gitignore before continuing.',
        exitCode: 0,
      },
    ],
    override: { flags: ['--allow-privacy-disclosure'], consentSemantics: 'Publish the retirement record and journal despite the uncovered destination for this invocation only.', preconditions: ['Review the archive destination and accept that local privacy state may be committed.'] },
    nextSteps: [
      { description: 'Review the destination, then repeat with per-invocation consent if you accept the commit risk.', command: 'replaytest retire <slug> --confirm-retire --allow-privacy-disclosure' },
      { description: 'For a warning, add the named destination to .gitignore; the command has already continued.' },
    ],
  },
  {
    verb: 'fix-selector',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.',
    meaning: 'Selector repair refuses the spec write while an in-progress retirement journal owns the slug.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A selector patch reached its write-time retirement revalidation.', message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before applying the selector patch.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'fix-selector',
    code: 'invalid-hand-finished-registry',
    contentStatus: 'explained',
    message: 'Refusing to use .replaytest/hand-finished.json: {{error}}',
    meaning: 'The local hand-finished registry is not usable, so selector repair cannot safely decide whether the generated spec is protected.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The hand-finished registry cannot be parsed or does not have the expected shape.', message: 'Refusing to use .replaytest/hand-finished.json: {{error}}' }],
    override: noOverride,
    nextSteps: [{ description: 'Repair the named hand-finished registry file, then run selector repair again.' }],
  },
  {
    verb: 'accept',
    code: 'different-journey',
    contentStatus: 'explained',
    message: 'Refusing to accept "{{slug}}": this proposal is backed by a different recorded session. Source recording changes from session {{previousSessionId}} (distinct ID {{previousDistinctId}}; signature {{previousSignature}}) to session {{nextSessionId}} (distinct ID {{nextDistinctId}}; signature {{nextSignature}}). Pass --confirm-different-journey only after reviewing that replacement. Re-run: `replaytest accept {{slug}} --force --confirm-different-journey`.',
    meaning: 'The proposed plan is backed by a different recorded journey than the live plan.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The proposed and live plans name different recorded journeys.', message: 'Refusing to accept "{{slug}}": this proposal is backed by a different recorded session. Source recording changes from session {{previousSessionId}} (distinct ID {{previousDistinctId}}; signature {{previousSignature}}) to session {{nextSessionId}} (distinct ID {{nextDistinctId}}; signature {{nextSignature}}). Pass --confirm-different-journey only after reviewing that replacement. Re-run: `replaytest accept {{slug}} --force --confirm-different-journey`.' }],
    override: {
      flags: ['--force', '--confirm-different-journey'],
      consentSemantics: 'Together, these flags replace the live plan and confirm the disclosed different journey.',
      preconditions: ['Review the proposal headline and diff before confirming the replacement.'],
    },
    nextSteps: [{ description: 'Review the proposed plan and its diff before deciding whether to replace the live plan.' }],
  },
  {
    verb: 'accept',
    code: 'invalid-hand-finished-registry',
    contentStatus: 'explained',
    message: 'Refusing to use .replaytest/hand-finished.json: {{error}}',
    meaning: 'The local hand-finished registry is not in a usable form, so the command cannot safely decide how to handle the plan.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The hand-finished registry cannot be parsed or does not have the expected shape.', message: 'Refusing to use .replaytest/hand-finished.json: {{error}}' }],
    override: noOverride,
    nextSteps: [{ description: 'Repair the named hand-finished registry file, then run accept again.' }],
  },
  {
    verb: 'accept',
    code: 'invalid-live-plan',
    contentStatus: 'explained',
    message: 'Cannot verify whether accepting "{{slug}}" would replace a different journey: the live plan could not be parsed ({{reason}}). Fix {{liveDisplayPath}} by hand, or overwrite it by re-planning the original session (`replaytest plan <distinctId> --force`) if you still have it, then re-run accept.',
    meaning: 'The existing live plan cannot be used as the safe baseline for acceptance.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The live plan file is present but cannot be parsed.', message: 'Cannot verify whether accepting "{{slug}}" would replace a different journey: the live plan could not be parsed ({{reason}}). Fix {{liveDisplayPath}} by hand, or overwrite it by re-planning the original session (`replaytest plan <distinctId> --force`) if you still have it, then re-run accept.' }],
    override: noOverride,
    nextSteps: [{ description: 'Repair the live plan by hand, or replace it from its recorded session.', command: 'replaytest plan <distinctId> --force' }],
  },
  {
    verb: 'accept',
    code: 'invalid-proposal',
    contentStatus: 'explained',
    message: 'Cannot accept proposal for "{{slug}}": invalid proposed plan JSON ({{reason}}). Fix {{proposedDisplayPath}} by hand, or write a fresh proposal with `replaytest triage {{slug}} --propose` or `replaytest regenerate {{slug}}`.',
    meaning: 'The proposed plan file cannot be safely promoted because it cannot be parsed.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The proposed plan file is present but cannot be parsed.', message: 'Cannot accept proposal for "{{slug}}": invalid proposed plan JSON ({{reason}}). Fix {{proposedDisplayPath}} by hand, or write a fresh proposal with `replaytest triage {{slug}} --propose` or `replaytest regenerate {{slug}}`.' }],
    override: noOverride,
    nextSteps: [
      { description: 'Create a new proposal from a triage run.', command: 'replaytest triage <slug> --propose' },
      { description: 'Create a new proposal from fresh traffic.', command: 'replaytest regenerate <slug>' },
    ],
  },
  {
    verb: 'accept',
    code: 'live-plan-exists',
    contentStatus: 'explained',
    message: '{{liveDisplayPath}} already exists for "{{slug}}" — refusing to overwrite the live plan. Pass --force to promote this proposal.',
    meaning: 'Acceptance would replace an existing live plan, and replacement needs explicit consent.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A valid live plan is already present for the slug.', message: '{{liveDisplayPath}} already exists for "{{slug}}" — refusing to overwrite the live plan. Pass --force to promote this proposal.' }],
    override: {
      flags: ['--force'],
      consentSemantics: 'This flag permits replacing the existing live plan with the proposed plan.',
      preconditions: ['Review the proposed plan and its diff before replacing the live plan.'],
    },
    nextSteps: [{ description: 'Review the proposed plan and its diff, then choose whether to replace the live plan.' }],
  },
  {
    verb: 'accept',
    code: 'missing-proposal',
    contentStatus: 'explained',
    message: 'No proposal found for "{{slug}}" at {{proposedDisplayPath}}. Run `replaytest heal --propose`, `replaytest triage {{slug}} --propose`, or `replaytest regenerate {{slug}}` first.',
    meaning: 'There is no proposed plan available to promote for this slug.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The proposed plan file does not exist.', message: 'No proposal found for "{{slug}}" at {{proposedDisplayPath}}. Run `replaytest heal --propose`, `replaytest triage {{slug}} --propose`, or `replaytest regenerate {{slug}}` first.' }],
    override: noOverride,
    nextSteps: [
      { description: 'Create a proposal from a triage run.', command: 'replaytest triage <slug> --propose' },
      { description: 'Create a proposal from fresh traffic.', command: 'replaytest regenerate <slug>' },
    ],
  },
  {
    verb: 'accept',
    code: 'retired-no-resurrect',
    contentStatus: 'explained',
    message: 'Refusing to accept "{{slug}}": This journey was retired. Retirement record: .replaytest/retired/{{slug}}/retirement.json — see it for the reversal recipe. Re-planning is the sanctioned fresh start — run `replaytest plan <distinctId>` to create a new live plan for this journey first, then accept.',
    meaning: 'The slug was retired, so accepting a proposal would silently bring back a retired journey.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The slug has a retirement record but no live plan.', message: 'Refusing to accept "{{slug}}": This journey was retired. Retirement record: .replaytest/retired/{{slug}}/retirement.json — see it for the reversal recipe. Re-planning is the sanctioned fresh start — run `replaytest plan <distinctId>` to create a new live plan for this journey first, then accept.' }],
    override: noOverride,
    nextSteps: [{ description: 'Create a new live plan from a retained source session before accepting a proposal.', command: 'replaytest plan <distinctId>' }],
  },
  {
    verb: 'accept',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before accept can write. Resume with `replaytest retire {{slug}} --confirm-retire`.',
    meaning: 'Accept is interlocked while an in-progress retirement journal owns this slug.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'Acceptance attempted a plan-family write while a retirement journal owns the slug.', message: 'Retirement recovery is required for "{{slug}}" before accept can write. Resume with `replaytest retire {{slug}} --confirm-retire`.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before accepting.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'doctor',
    code: 'unconfigured',
    contentStatus: 'explained',
    message: 'Cannot run doctor: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.',
    meaning: 'Doctor cannot inspect the workspace until the connection settings are present.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The workspace has no usable connection settings.', message: 'Cannot run doctor: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.' }],
    override: noOverride,
    nextSteps: [{ description: 'Write the workspace connection settings.', command: 'replaytest init' }],
  },
  {
    verb: 'explain',
    code: 'ambiguous-code',
    contentStatus: 'explained',
    message: 'More than one recognized refusal code matches "{{input}}".',
    meaning: 'The code without a verb prefix names more than one refusal, so explain will not guess.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A bare code matches entries under more than one verb.', message: 'More than one recognized refusal code matches "{{input}}".' }],
    override: noOverride,
    nextSteps: [{ description: 'Run explain again with one of the listed namespaced codes.' }],
  },
  {
    verb: 'explain',
    code: 'unknown-code',
    contentStatus: 'explained',
    message: 'No recognized refusal code matches "{{input}}".',
    meaning: 'The supplied code is not in the current local registry.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'No namespaced or unambiguous bare code matches the input.', message: 'No recognized refusal code matches "{{input}}".' }],
    override: noOverride,
    nextSteps: [{ description: 'List the codes available in this release.', command: 'replaytest explain --list' }],
  },
  {
    verb: 'regenerate',
    code: 'cross-origin-candidates',
    contentStatus: 'explained',
    message: 'Regenerate found {{candidateCount}} cross-origin candidate(s) {{crossOriginTag}} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.',
    meaning: 'The fresh candidates do not stay within one recorded site, so the command withholds them by default.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'Every fresh candidate touched more than one origin or lacks the recorded origin.', message: 'Regenerate found {{candidateCount}} cross-origin candidate(s) {{crossOriginTag}} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.' }],
    override: {
      flags: ['--allow-cross-origin'],
      consentSemantics: 'This flag allows the command to consider candidates outside the recorded site boundary.',
      preconditions: ['Review the other site before allowing cross-origin candidates.'],
    },
    nextSteps: [{ description: 'Select the intended app scope, or review the other site before allowing cross-origin candidates.' }],
  },
  {
    verb: 'regenerate',
    code: 'degraded-scan',
    contentStatus: 'explained',
    message: 'Cannot regenerate from partial fresh traffic ({{degradedReasons}}). Re-run once the scan completes.',
    meaning: 'The scan did not finish with enough coverage to make a safe regeneration decision.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The fresh-traffic scan returned partial coverage.', message: 'Cannot regenerate from partial fresh traffic ({{degradedReasons}}). Re-run once the scan completes.' }],
    override: noOverride,
    nextSteps: [{ description: 'Run regenerate again after the scan can complete.' }],
  },
  {
    verb: 'regenerate',
    code: 'no-candidates',
    contentStatus: 'explained',
    message: 'Fresh traffic could not be scanned ({{error}}). Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}). {{staleRecovery}}',
    meaning: 'No safe fresh candidate is available for regeneration in the searched traffic.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [
      { description: 'The fresh-traffic scan itself failed before candidates could be assessed.', message: 'Fresh traffic could not be scanned ({{error}}). Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}). {{staleRecovery}}' },
      { description: 'The scan completed but found no plannable fresh candidate.', message: 'No plannable fresh candidate was found.{{entryNote}} Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}).{{crossOriginWithheld}} {{staleRecovery}}' },
    ],
    override: noOverride,
    nextSteps: [
      { description: 'Search a wider time window.', command: 'replaytest regenerate <slug> --since-hours <hours>' },
      { description: 'Re-plan from a retained source session if one is available.', command: 'replaytest plan <distinctId>' },
    ],
  },
  {
    verb: 'regenerate',
    code: 'origin-unrecorded',
    contentStatus: 'explained',
    message: 'Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.',
    meaning: 'No site address could be resolved from the plan, its retained source session or the selected app scope, so the command cannot safely compare fresh candidates to one site.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'No site address could be resolved from the plan, its retained source session or the selected app scope.', message: 'Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.' }],
    override: {
      flags: ['--allow-cross-origin'],
      consentSemantics: 'This flag permits regeneration without a recorded origin boundary.',
      preconditions: ['Confirm the site whose traffic should be considered before allowing cross-origin candidates.'],
    },
    nextSteps: [
      { description: 'Re-plan from a retained source session.', command: 'replaytest plan <distinctId>' },
      { description: 'Select an app scope with one configured origin.' },
    ],
  },
  {
    verb: 'regenerate',
    code: 'proposal-slot-occupied',
    contentStatus: 'explained',
    message: 'Cannot regenerate while an unresolved proposal already occupies the review slot: {{proposedJsonPath}}, {{proposedMarkdownPath}}, or {{proposedDiffPath}}. Resolve it with `replaytest accept {{slug}}` or discard it deliberately, then run `replaytest regenerate {{slug}}`.',
    meaning: 'A proposed plan, Markdown file, or diff already exists for this slug.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'At least one proposed artifact already exists.', message: 'Cannot regenerate while an unresolved proposal already occupies the review slot: {{proposedJsonPath}}, {{proposedMarkdownPath}}, or {{proposedDiffPath}}. Resolve it with `replaytest accept {{slug}}` or discard it deliberately, then run `replaytest regenerate {{slug}}`.' }],
    override: {
      flags: ['--force'],
      consentSemantics: 'This flag permits replacing the existing proposed files only.',
      preconditions: ['Review or deliberately discard the existing proposal first.'],
    },
    nextSteps: [{ description: 'Resolve the existing proposal before making another one.', command: 'replaytest accept <slug>' }],
  },
  {
    verb: 'regenerate',
    code: 'signature-unresolvable',
    contentStatus: 'explained',
    message: 'Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.',
    meaning: 'The command cannot determine the recorded journey shape needed to compare fresh traffic.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The plan has no usable recorded journey signature.', message: 'Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.' }],
    override: noOverride,
    nextSteps: [{ description: 'Create a fresh plan from a retained source session.', command: 'replaytest plan <distinctId>' }],
  },
  {
    verb: 'regenerate',
    code: 'unconfigured',
    contentStatus: 'message-only',
    message: 'Cannot regenerate: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.',
    meaning: 'This code has no detailed explanation; the message is the full description.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The workspace has no usable connection settings.', message: 'Cannot regenerate: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.' }],
    override: noOverride,
    nextSteps: [{ description: 'Write the workspace connection settings, then run regenerate again.', command: 'replaytest init' }],
  },
  {
    verb: 'regenerate',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before regenerate can write. Resume with `replaytest retire {{slug}} --confirm-retire`.',
    meaning: 'Regenerate is interlocked while an in-progress retirement journal owns this slug.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A live proposal or empty-search write was attempted during retire recovery.', message: 'Retirement recovery is required for "{{slug}}" before regenerate can write. Resume with `replaytest retire {{slug}} --confirm-retire`.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before regenerating.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'plan',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.',
    meaning: 'Plan publication is interlocked while an in-progress retirement journal owns this slug.',
    evidenceClass: 'message-only',
    jsonVisible: false,
    exitCode: 1,
    tier: 'B',
    cases: [{ description: 'A plan batch reaches the write path for a slug under retire recovery.', message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before writing the plan.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'scaffold',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.',
    meaning: 'Spec scaffolding is interlocked while an in-progress retirement journal owns this slug.',
    evidenceClass: 'message-only',
    jsonVisible: false,
    exitCode: 1,
    tier: 'B',
    cases: [{ description: 'Scaffold reaches a write path for a slug under retire recovery.', message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before scaffolding.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'reconcile',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.',
    meaning: 'Each reconcile --apply rename is interlocked per slug while retire recovery is in progress.',
    evidenceClass: 'message-only',
    jsonVisible: false,
    exitCode: 1,
    tier: 'B',
    cases: [{ description: 'The real multi-slug reconcile --apply loop reaches a recovery-owned slug.', message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before reconciling this slug.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'triage',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}" before this read can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.',
    meaning: 'Triage refuses a live sidecar under an in-progress retirement journal rather than reading through recovery.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'Triage reads a sidecar for a slug owned by an in-progress retirement journal.', message: 'Retirement recovery is required for "{{slug}}" before this read can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.' }],
    override: noOverride,
    nextSteps: [{ description: 'Resume the retirement before triaging.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'retire',
    code: 'already-retired',
    contentStatus: 'explained',
    message: 'No live plan found for "{{slug}}". This journey was retired on {{retiredAt}}. Retirement record: {{recordPath}} — see it for the reversal recipe. {{evidenceBasisClause}}.{{priorClause}}',
    meaning: 'There is no live plan to retire, and the slug already has a local retirement record.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'No live plan exists and a retired folder is present.', message: 'No live plan found for "{{slug}}". This journey was retired on {{retiredAt}}. Retirement record: {{recordPath}} — see it for the reversal recipe. {{evidenceBasisClause}}.{{priorClause}}' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the retirement record before deciding whether a new plan is needed.' }],
  },
  {
    verb: 'retire',
    code: 'retirement-recovery-required',
    contentStatus: 'explained',
    message: 'Retirement recovery is required for "{{slug}}". Resume with `replaytest retire {{slug}} --confirm-retire`.',
    meaning: 'An in-progress retirement journal owns this slug and the operator must resume it before another retire-owned decision can proceed.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'An in-progress retirement journal is present and the operator did not confirm resume.', message: 'Retirement recovery is required for "{{slug}}". Resume with `replaytest retire {{slug}} --confirm-retire`.' }],
    override: { flags: ['--confirm-retire'], consentSemantics: 'This flag re-affirms the original retirement consent and permits deterministic journal resume.', preconditions: ['Inspect the journal and archive paths named by the recovery view.'] },
    nextSteps: [{ description: 'Resume the in-progress retirement.', command: 'replaytest retire <slug> --confirm-retire' }],
  },
  {
    verb: 'retire',
    code: 'retirement-archive-divergent',
    contentStatus: 'explained',
    message: 'Retirement archive divergence for "{{slug}}": {{detail}} Reconcile the named paths, then re-run `replaytest retire {{slug}} --confirm-retire`.',
    meaning: 'The frozen journal roster and the on-disk archive disagree, so the tool refuses to guess which bytes should survive.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A journal row is in an impossible or externally changed mixed state.', message: 'Retirement archive divergence for "{{slug}}": {{detail}} Reconcile the named paths, then re-run `replaytest retire {{slug}} --confirm-retire`.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the named source and destination, choose the surviving copy where one exists, and resume the journal.' }],
  },
  {
    verb: 'retire',
    code: 'retirement-record-unreadable',
    contentStatus: 'explained',
    message: 'Retirement record is unreadable at {{recordPath}}. Automatic recovery cannot trust it; inspect the file, then re-run `replaytest retire {{slug}} --confirm-retire`.',
    meaning: 'An archive directory exists but its completed retirement record is malformed or unreadable.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The completed retirement record cannot be parsed or read.', message: 'Retirement record is unreadable at {{recordPath}}. Automatic recovery cannot trust it; inspect the file, then re-run `replaytest retire {{slug}} --confirm-retire`.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the named retirement record and use the guarded recovery route.' }],
  },
  {
    verb: 'retire',
    code: 'retirement-journal-unreadable',
    contentStatus: 'explained',
    message: 'Retirement journal is unreadable at {{journalPath}}. Automatic resume is impossible; inspect it manually, then re-run `replaytest retire {{slug}} --confirm-retire` only after reconciling the archive.',
    meaning: 'A published retirement journal is malformed or truncated.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The published journal cannot be parsed.', message: 'Retirement journal is unreadable at {{journalPath}}. Automatic resume is impossible; inspect it manually, then re-run `replaytest retire {{slug}} --confirm-retire` only after reconciling the archive.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the named journal and follow the guarded manual route; no sanctioned abandon path exists.' }],
  },
  {
    verb: 'retire',
    code: 'retirement-lock-held',
    contentStatus: 'explained',
    message: 'Retirement lock is held for "{{slug}}" ({{lockState}}). Another retire may still be running — or an earlier one crashed and left its lock behind; the lock could also be leftover or corrupted. If a process id is named, check whether that process is still alive first. If no retire is actually running, recover with: replaytest retire {{slug}} --confirm-retire --steal-lock. Stealing the lock from a retire that is still running can corrupt its work, and two people recovering at the same time can still collide.',
    meaning: 'Every visible lock shape refuses honestly until an operator explicitly consents to steal it.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'A live, dead, aged, initializing, or corrupt retire lock is present.', message: 'Retirement lock is held for "{{slug}}" ({{lockState}}). Another retire may still be running — or an earlier one crashed and left its lock behind; the lock could also be leftover or corrupted. If a process id is named, check whether that process is still alive first. If no retire is actually running, recover with: replaytest retire {{slug}} --confirm-retire --steal-lock. Stealing the lock from a retire that is still running can corrupt its work, and two people recovering at the same time can still collide.' }],
    override: { flags: ['--steal-lock'], consentSemantics: 'This flag explicitly consents to removing a visible lock, even one a running retire still holds; if two people try to steal at the same time, they can still collide.', preconditions: ['If the lock names a process id, check whether that process is still alive first; if the lock is unreadable, inspect the lock and archive paths before stealing.'] },
    nextSteps: [{ description: 'Use the single consented recovery command.', command: 'replaytest retire <slug> --confirm-retire --steal-lock' }],
  },
  {
    verb: 'retire',
    code: 'confirm-requires-bar-or-no-evidence',
    contentStatus: 'explained',
    message: 'Refusing to retire "{{slug}}": the evidence bar is not met. {{unmetReason}} Gather more evidence with `replaytest regenerate {{slug}}`, or retire on operator assertion with `replaytest retire {{slug}} --confirm-retire --no-evidence` (the tool records the assertion, never adopts it).',
    meaning: 'Retirement was requested, but the recorded empty-search evidence has not met the bar and no operator assertion was supplied.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The operator passed --confirm-retire while the evidence bar was not met.', message: 'Refusing to retire "{{slug}}": the evidence bar is not met. {{unmetReason}} Gather more evidence with `replaytest regenerate {{slug}}`, or retire on operator assertion with `replaytest retire {{slug}} --confirm-retire --no-evidence` (the tool records the assertion, never adopts it).' }],
    override: {
      flags: ['--confirm-retire', '--no-evidence'],
      consentSemantics: 'Together, these flags record an operator assertion to retire below the evidence bar.',
      preconditions: ['Review the recorded evidence and the retirement record that will be written.'],
    },
    nextSteps: [{ description: 'Gather another fresh-traffic search, or decide whether to retire on an operator assertion.', command: 'replaytest regenerate <slug>' }],
  },
  {
    verb: 'retire',
    code: 'no-evidence-requires-confirm',
    contentStatus: 'explained',
    message: 'Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar. Re-run: `replaytest retire {{slug}} --confirm-retire --no-evidence`.',
    meaning: 'The operator supplied the below-bar flag without the separate confirmation required to retire.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The operator passed --no-evidence without --confirm-retire.', message: 'Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar. Re-run: `replaytest retire {{slug}} --confirm-retire --no-evidence`.' }],
    override: {
      flags: ['--confirm-retire', '--no-evidence'],
      consentSemantics: 'Together, these flags record an operator assertion to retire below the evidence bar.',
      preconditions: ['Review the recorded evidence and the retirement record that will be written.'],
    },
    nextSteps: [{ description: 'Use both flags only when you intend to record an operator assertion.', command: 'replaytest retire <slug> --confirm-retire --no-evidence' }],
  },
  {
    verb: 'retire',
    code: 'no-plan',
    contentStatus: 'explained',
    message: 'No live plan found for "{{slug}}" — run: replaytest plan <distinctId>.',
    meaning: 'The live plan cannot be used for retirement because it is absent, unreadable, or invalid.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [
      { description: 'No live plan file exists.', message: 'No live plan found for "{{slug}}" — run: replaytest plan <distinctId>.' },
      { description: 'The live plan file cannot be parsed.', message: 'Cannot retire "{{slug}}": the live plan could not be parsed ({{reason}}). Repair it before retiring.' },
      { description: 'The live plan file cannot be read.', message: 'Cannot retire "{{slug}}": the live plan could not be read ({{error}}).' },
    ],
    override: noOverride,
    nextSteps: [{ description: 'Create or repair the live plan before retiring.', command: 'replaytest plan <distinctId>' }],
  },
  {
    verb: 'retire',
    code: 'partial-failure',
    contentStatus: 'explained',
    message: 'Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json could not be written: {{initialError}}.\nManual completion steps:\n  1. Re-run `replaytest retire {{slug}} --confirm-retire` to retry the archival.',
    meaning: 'The retirement sequence started but could not finish every write, move, or cleanup step.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [
      { description: 'The retirement record could not be written before any artifact moves.', message: 'Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json could not be written: {{initialError}}.\nManual completion steps:\n  1. Re-run `replaytest retire {{slug}} --confirm-retire` to retry the archival.' },
      { description: 'Some artifacts moved or cleanup ran, but one or more later steps failed.', message: 'Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json was written to {{retirementJsonPath}}.\n{{movedSection}}{{notMovedSection}}{{stateCleanupSection}}Manual completion steps:\n{{manualCompletionSteps}}{{specBaselineWarning}}' },
    ],
    override: noOverride,
    nextSteps: [{ description: 'Read the printed manual completion steps and the retirement record before making another change.' }],
  },
  {
    verb: 'triage',
    code: 'invalid-hand-finished-registry',
    contentStatus: 'explained',
    message: 'Refusing to use .replaytest/hand-finished.json: {{error}}',
    meaning: 'The local hand-finished registry is not in a usable form, so triage cannot safely decide how to handle the plan.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The hand-finished registry cannot be parsed or does not have the expected shape.', message: 'Refusing to use .replaytest/hand-finished.json: {{error}}' }],
    override: noOverride,
    nextSteps: [{ description: 'Repair the named hand-finished registry file, then run triage again.' }],
  },
  {
    verb: 'triage',
    code: 'invalid-sidecar',
    contentStatus: 'explained',
    message: 'Cannot triage "{{slug}}": invalid sidecar ({{reason}}). Fix {{displayPath}} by hand, or overwrite it fresh with `replaytest plan <distinctId> --force` if you still have the original session.',
    meaning: 'The plan sidecar is present but cannot be parsed into the required shape.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The sidecar file is malformed or does not match the expected shape.', message: 'Cannot triage "{{slug}}": invalid sidecar ({{reason}}). Fix {{displayPath}} by hand, or overwrite it fresh with `replaytest plan <distinctId> --force` if you still have the original session.' }],
    override: noOverride,
    nextSteps: [{ description: 'Repair the named sidecar, or replace it from the original session.', command: 'replaytest plan <distinctId> --force' }],
  },
  {
    verb: 'triage',
    code: 'missing-sidecar',
    contentStatus: 'explained',
    message: 'Cannot triage "{{slug}}": no sidecar found at {{displayPath}}. If this journey should exist, create it with `replaytest plan <distinctId>`; if the slug is wrong, check .replaytest/plans/ for the correct one.',
    meaning: 'Triage needs a plan sidecar for the supplied slug, but no sidecar exists there.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'No sidecar file exists for the supplied slug.', message: 'Cannot triage "{{slug}}": no sidecar found at {{displayPath}}. If this journey should exist, create it with `replaytest plan <distinctId>`; if the slug is wrong, check .replaytest/plans/ for the correct one.' }],
    override: noOverride,
    nextSteps: [{ description: 'Create the sidecar for the journey.', command: 'replaytest plan <distinctId>' }],
  },
  {
    verb: 'triage',
    code: 'proposed-exists',
    contentStatus: 'explained',
    message: 'Cannot write proposal: {{jsonPath}}, {{markdownPath}}, or {{diffPath}} already exists. Pass --force to overwrite proposed files only.',
    meaning: 'A proposed plan, Markdown file, or diff already exists for this slug.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'At least one proposed artifact already exists.', message: 'Cannot write proposal: {{jsonPath}}, {{markdownPath}}, or {{diffPath}} already exists. Pass --force to overwrite proposed files only.' }],
    override: {
      flags: ['--force'],
      consentSemantics: 'This flag permits replacing the existing proposed files only.',
      preconditions: ['Review or deliberately discard the existing proposal first.'],
    },
    nextSteps: [{ description: 'Review the existing proposal before choosing whether to replace it.' }],
  },
  {
    verb: 'triage',
    code: 'signature-unresolvable',
    contentStatus: 'explained',
    message: 'Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.',
    meaning: 'Triage cannot find a usable recorded journey shape for the plan.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [
      { description: 'The original session is unavailable and the plan has no recorded signature.', message: 'Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.' },
      { description: 'The original session no longer contains the recorded completed journey.', message: 'Cannot triage: the original session no longer contains the recorded completed journey and this plan has no recorded signature - regenerate the plan.' },
      { description: 'The matching journey is a merged multi-create route that triage does not use.', message: 'Cannot triage: the recorded journey is now recognized as navigated, but it contains more than one input-then-new-route commit — several creates merged into one journey because journeys are still split on form submits. Planning it would name the test after the last record while its steps create the first, and list every created record as data to seed first. Splitting merged creates is not built yet, so this journey is skipped rather than planned wrongly. Nothing is wrong with the session — regenerate the plan from a session whose create stands alone.' },
    ],
    override: noOverride,
    nextSteps: [{ description: 'Create a proposal from fresh traffic after the plan has a usable recorded journey.', command: 'replaytest regenerate <slug>' }],
  },
  {
    verb: 'triage',
    code: 'unconfigured',
    contentStatus: 'explained',
    message: 'Cannot triage: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.',
    meaning: 'Triage cannot read fresh traffic until the connection settings are present.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The workspace has no usable connection settings.', message: 'Cannot triage: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.' }],
    override: noOverride,
    nextSteps: [{ description: 'Write the workspace connection settings.', command: 'replaytest init' }],
  },
  {
    verb: 'accept',
    code: 'state-lock-held',
    contentStatus: 'explained',
    message: 'state-lock-held: accept refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.',
    meaning: 'Acceptance could not obtain the shared state-writer lease.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: stateLockHeldCases('accept'),
    override: { flags: ['--steal-state-lock'], consentSemantics: 'Stealing may allow one live holder write to land over recent state.', preconditions: ['Confirm no live state writer is making progress.'] },
    nextSteps: [{ description: 'Retry after the state writer completes, or deliberately use the state-lock steal flag.' }],
  },
  {
    verb: 'accept',
    code: 'state-lock-fenced',
    contentStatus: 'explained',
    message: 'state-lock-fenced: accept stopped before publishing because another command took over the shared write lock. Re-run accept.',
    meaning: 'Acceptance lost the shared state-writer lease before publication.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The state lease generation changed before a publication.', message: 'state-lock-fenced: accept stopped before publishing because another command took over the shared write lock. Re-run accept.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the shared state files and retry acceptance.' }],
  },
  {
    verb: 'retire',
    code: 'state-lock-held',
    contentStatus: 'explained',
    message: 'state-lock-held: retire refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state. If both retire locks are held by dead owners, recover them with replaytest retire {{slug}} --recover-crashed-locks. Granular form: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock.',
    meaning: 'Retirement could not obtain the shared state-writer lease after taking the retire lock.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: stateLockHeldCases('retire'),
    override: { flags: ['--steal-state-lock'], consentSemantics: 'Stealing may allow one live holder write to land over recent state.', preconditions: ['Confirm no live state writer is making progress.'] },
    nextSteps: [{ description: 'Retry after the state writer completes, or deliberately use the state-lock steal flag.' }],
  },
  {
    verb: 'retire',
    code: 'state-lock-fenced',
    contentStatus: 'explained',
    message: 'state-lock-fenced: retire stopped before publishing because another command took over the shared write lock. Re-run retire.',
    meaning: 'Retirement lost the shared state-writer lease before publication.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The state lease generation changed before a publication.', message: 'state-lock-fenced: retire stopped before publishing because another command took over the shared write lock. Re-run retire.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the shared state files and resume retirement.' }],
  },
  {
    verb: 'triage',
    code: 'state-lock-held',
    contentStatus: 'explained',
    message: 'state-lock-held: triage refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.',
    meaning: 'Triage could not obtain the shared state-writer lease.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: stateLockHeldCases('triage'),
    override: { flags: ['--steal-state-lock'], consentSemantics: 'Stealing may allow one live holder write to land over recent state.', preconditions: ['Confirm no live state writer is making progress.'] },
    nextSteps: [{ description: 'Retry after the state writer completes, or deliberately use the state-lock steal flag.' }],
  },
  {
    verb: 'triage',
    code: 'state-lock-fenced',
    contentStatus: 'explained',
    message: 'state-lock-fenced: triage stopped before publishing because another command took over the shared write lock. Re-run triage.',
    meaning: 'Triage lost the shared state-writer lease before publication.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The state lease generation changed before a publication.', message: 'state-lock-fenced: triage stopped before publishing because another command took over the shared write lock. Re-run triage.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the shared state files and retry triage.' }],
  },
  {
    verb: 'scaffold',
    code: 'state-lock-held',
    contentStatus: 'explained',
    message: 'state-lock-held: scaffold refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.',
    meaning: 'Scaffold could not obtain the shared state-writer lease.',
    evidenceClass: 'message-only',
    jsonVisible: false,
    exitCode: 1,
    tier: 'A',
    cases: stateLockHeldCases('scaffold'),
    override: { flags: ['--steal-state-lock'], consentSemantics: 'Stealing may allow one live holder write to land over recent state.', preconditions: ['Confirm no live state writer is making progress.'] },
    nextSteps: [{ description: 'Retry after the state writer completes, or deliberately use the state-lock steal flag.' }],
  },
  {
    verb: 'scaffold',
    code: 'state-lock-fenced',
    contentStatus: 'explained',
    message: 'state-lock-fenced: scaffold stopped before publishing because another command took over the shared write lock. Re-run scaffold.',
    meaning: 'Scaffold lost the shared state-writer lease before publication.',
    evidenceClass: 'message-only',
    jsonVisible: false,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The state lease generation changed before a publication.', message: 'state-lock-fenced: scaffold stopped before publishing because another command took over the shared write lock. Re-run scaffold.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the shared state files and retry scaffold.' }],
  },
  {
    verb: 'fix-selector',
    code: 'state-lock-held',
    contentStatus: 'explained',
    message: 'state-lock-held: fix-selector refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.',
    meaning: 'Selector repair could not obtain the shared state-writer lease.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: stateLockHeldCases('fix-selector'),
    override: { flags: ['--steal-state-lock'], consentSemantics: 'Stealing may allow one live holder write to land over recent state.', preconditions: ['Confirm no live state writer is making progress.'] },
    nextSteps: [{ description: 'Retry after the state writer completes, or deliberately use the state-lock steal flag.' }],
  },
  {
    verb: 'fix-selector',
    code: 'state-lock-fenced',
    contentStatus: 'explained',
    message: 'state-lock-fenced: fix-selector stopped before publishing because another command took over the shared write lock. Re-run fix-selector.',
    meaning: 'Selector repair lost the shared state-writer lease before publication.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [{ description: 'The state lease generation changed before a publication.', message: 'state-lock-fenced: fix-selector stopped before publishing because another command took over the shared write lock. Re-run fix-selector.' }],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the shared state files and retry selector repair.' }],
  },
  {
    verb: 'heal',
    code: 'state-lock-held',
    contentStatus: 'explained',
    message: 'state-lock-held: heal refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.',
    meaning: 'Heal could not obtain the shared state-writer lease.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: stateLockHeldCases('heal'),
    override: { flags: ['--steal-state-lock'], consentSemantics: 'Stealing may allow one live holder write to land over recent state.', preconditions: ['Confirm no live state writer is making progress.'] },
    nextSteps: [{ description: 'Retry after the state writer completes, or deliberately use the state-lock steal flag.' }],
  },
  {
    verb: 'heal',
    code: 'state-lock-fenced',
    contentStatus: 'explained',
    message: 'state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.',
    meaning: 'Heal lost the shared state-writer lease before publication.',
    evidenceClass: 'emitted-code',
    jsonVisible: true,
    exitCode: 1,
    tier: 'A',
    cases: [
      { description: 'The state lease generation changed before a publication.', message: 'state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.' },
      { description: 'The state lease generation changed after shared state was published.', message: 'state-lock-fenced: heal stopped after publishing shared state because the shared write lock changed. Check the named shared state files before re-running heal.' },
    ],
    override: noOverride,
    nextSteps: [{ description: 'Inspect the shared state files and retry heal.' }],
  },
  {
    verb: 'plan', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: plan refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'plan')}`,
    meaning: 'Plan could not obtain the shared coarse discovery-store lock.', evidenceClass: 'message-only', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('plan'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'plan', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: plan stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Plan lost the shared coarse discovery-store lock before a write.', evidenceClass: 'message-only', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: plan stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry plan.' }],
  },
  {
    verb: 'triage', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: triage refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'triage')}`,
    meaning: 'Triage could not obtain the shared coarse discovery-store lock.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('triage'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'triage', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: triage stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Triage lost the shared coarse discovery-store lock before a write.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: triage stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry triage.' }],
  },
  {
    verb: 'regenerate', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: regenerate refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'regenerate')}`,
    meaning: 'Regenerate could not obtain the shared coarse discovery-store lock.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('regenerate'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'regenerate', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: regenerate stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Regenerate lost the shared coarse discovery-store lock before a write.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: regenerate stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry regenerate.' }],
  },
  {
    verb: 'heal', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: heal refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'heal')}`,
    meaning: 'Heal could not obtain the shared coarse discovery-store lock.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('heal'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'heal', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: heal stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Heal lost the shared coarse discovery-store lock before a write.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: heal stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry heal.' }],
  },
  {
    verb: 'gaps', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: gaps refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'gaps')}`,
    meaning: 'Gaps could not obtain the shared coarse discovery-store lock.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('gaps'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'gaps', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: gaps stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Gaps lost the shared coarse discovery-store lock before a write.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: gaps stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry gaps.' }],
  },
  {
    verb: 'sessions', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: sessions refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'sessions')}`,
    meaning: 'Sessions could not obtain the shared coarse discovery-store lock.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('sessions'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'sessions', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: sessions stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Sessions lost the shared coarse discovery-store lock before a write.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: sessions stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry sessions.' }],
  },
  {
    verb: 'doctor', code: 'coarse-store-lock-held', contentStatus: 'explained',
    message: `coarse-store-lock-held: doctor refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', 'doctor')}`,
    meaning: 'Doctor could not obtain the shared coarse discovery-store lock.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: coarseStoreLockCases('doctor'), override: coarseStoreLockOverride(), nextSteps: [{ description: COARSE_STORE_LOCK_NEXT_STEP }],
  },
  {
    verb: 'doctor', code: 'coarse-store-lock-fenced', contentStatus: 'explained',
    message: 'coarse-store-lock-fenced: doctor stopped before a coarse-store write because its lock generation changed.',
    meaning: 'Doctor lost the shared coarse discovery-store lock before a write.', evidenceClass: 'emitted-code', jsonVisible: true, exitCode: 1, tier: 'A',
    cases: [{ description: 'The coarse-store lock generation changed before a slice or manifest write.', message: 'coarse-store-lock-fenced: doctor stopped before a coarse-store write because its lock generation changed.' }], override: noOverride, nextSteps: [{ description: 'Inspect the coarse-store lock and retry doctor.' }],
  },
  {
    verb: 'lock', code: 'order-invariant', contentStatus: 'explained',
    message: 'lock-order-invariant: a lock was requested in an invalid nesting order; this is an internal replaytest bug.',
    meaning: 'The process-local lock registry detected same-kind nesting or an unsanctioned lock-order edge.', evidenceClass: 'message-only', jsonVisible: true, exitCode: 70, tier: 'internal',
    cases: [{ description: 'A lock acquisition violates the fixed lock-order graph.', message: 'lock-order-invariant: a lock was requested in an invalid nesting order; this is an internal replaytest bug.' }], override: { flags: [], consentSemantics: 'No customer override exists for an internal invariant.', preconditions: ['Report the command and the lock kinds named in the error.'] }, nextSteps: [{ description: 'Report the invariant violation; do not recover it with a customer-facing steal flag.' }],
  },
] as const satisfies readonly RefusalRegistryEntry[];

export type RawRefusalRegistryEntryValue = (typeof REFUSAL_REGISTRY)[number];
export type RefusalRegistryEntryValue = RawRefusalRegistryEntryValue;
export type RefusalVerb = RawRefusalRegistryEntryValue['verb'];
export type RefusalCodeForVerb<Verb extends RefusalVerb> = Extract<RawRefusalRegistryEntryValue, { verb: Verb }>['code'];
export type NamespacedRefusalCode = `${RawRefusalRegistryEntryValue['verb']}.${RawRefusalRegistryEntryValue['code']}`;

export function namespacedRefusalCode(entry: Pick<RefusalRegistryEntry, 'verb' | 'code'>): string {
  return `${entry.verb}.${entry.code}`;
}

/** Deterministic public ordering: verb, then code. */
export function listedRefusalEntries(): readonly RefusalRegistryEntryValue[] {
  return [...REFUSAL_REGISTRY].sort((left, right) =>
    left.verb.localeCompare(right.verb) || left.code.localeCompare(right.code),
  );
}

export function refusalCoverage(): { explained: number; recognized: number; total: number } {
  const entries = listedRefusalEntries();
  const explained = entries.filter((entry) => entry.contentStatus === 'explained').length;
  const recognized = entries.filter((entry) => entry.contentStatus !== 'explained').length;
  return { explained, recognized, total: entries.length };
}

/** Exact namespaced lookup, followed by an unambiguous bare-code lookup. */
export function findRefusalEntries(input: string): readonly RefusalRegistryEntryValue[] {
  // `--list` is deliberately sorted for scanability. Bare-code ambiguity,
  // however, has always reflected the registry's declaration order.
  const declarationOrder = REFUSAL_REGISTRY;
  const exact = declarationOrder.filter((entry) => namespacedRefusalCode(entry) === input);
  if (exact.length > 0) return exact;
  return declarationOrder.filter((entry) => entry.code === input);
}
