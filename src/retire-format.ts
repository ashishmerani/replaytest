/**
 * Local rendering and report helpers for the retire transaction. Keeping the
 * human-facing rail separate leaves the verb focused on journal transitions;
 * the wording remains the same production channel used by retire tests.
 */

import * as path from 'node:path';

import { TOOL_NAME } from './cli/constants.js';
import { retiredDoorSentence } from './cli/retired-awareness.js';
import type { RetireJournal } from './retire-journal.js';
import { qualifyingEmptySearches, renderSuccessorObservations, RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS, type RetirementEvidenceStatus } from './retirement-evidence.js';
import type { Sidecar, SidecarEmptySearch, SidecarSuccessorObservation } from './sidecar.js';
import type { RetireEvidenceView, RetireRefusal, RetireResult } from './cli/verbs/retire.js';
import type { RetiredRecord } from './cli/retired-awareness.js';

export interface CleanupStepResult {
  name: string;
  ok: boolean;
  detail?: string;
  /** True only when this step removed a live state entry. */
  removedSomething?: boolean;
}

export interface PartialFailureFacts {
  slug: string;
  archiveDir: string;
  workspaceRoot: string;
  moved: string[];
  moveFailures: string[];
  cleanupResults: CleanupStepResult[];
  initialError?: string;
  specStillLive: boolean;
  hashEntryRemoved: boolean;
}

export function sidecarFromJournal(journal: RetireJournal): Sidecar {
  return {
    version: 1,
    title: journal.slug,
    source: { distinctId: '', sessionId: '', journeyIndex: 0, signature: '', generatedAt: journal.retiredAt, tool: 'replaytest' },
    start: '',
    steps: [],
    assertions: [],
  };
}

export function recoveryRefusal(slug: string, record: RetiredRecord): RetireRefusal {
  if (record.state === 'ghost') return { kind: 'refusal', code: 'retirement-archive-divergent', message: retiredDoorSentence(slug, record), exitCode: 1 };
  if (record.state === 'unreadable') return { kind: 'refusal', code: 'retirement-record-unreadable', message: retiredDoorSentence(slug, record), exitCode: 1 };
  if (record.state === 'journal-unreadable') return { kind: 'refusal', code: 'retirement-journal-unreadable', message: retiredDoorSentence(slug, record), exitCode: 1 };
  return { kind: 'refusal', code: 'retirement-recovery-required', message: retiredDoorSentence(slug, record), exitCode: 1 };
}

export function retirementStateRefusal(slug: string, state: RetiredRecord): RetireRefusal {
  if (state.state === 'ghost') return { kind: 'refusal', code: 'retirement-archive-divergent', message: `Retirement state for "${slug}" requires recovery. ${retiredDoorSentence(slug, state)}`, exitCode: 1 };
  if (state.state === 'journal-unreadable') return { kind: 'refusal', code: 'retirement-journal-unreadable', message: `Retirement state for "${slug}" requires recovery. ${retiredDoorSentence(slug, state)}`, exitCode: 1 };
  if (state.state === 'unreadable') return { kind: 'refusal', code: 'retirement-record-unreadable', message: `Retirement state for "${slug}" requires recovery. ${retiredDoorSentence(slug, state)}`, exitCode: 1 };
  return { kind: 'refusal', code: 'retirement-recovery-required', message: `Retirement state for "${slug}" requires recovery. ${retiredDoorSentence(slug, state)}`, exitCode: 1 };
}

export function divergenceRefusal(slug: string, detail: string): RetireRefusal {
  return {
    kind: 'refusal',
    code: 'retirement-archive-divergent',
    message: `Retirement archive divergence for "${slug}": ${detail} Inspect the named paths and choose the surviving copy where one exists; if neither exists, restore from a user backup or accept the artifact as lost and re-plan. Then re-run replaytest retire ${slug} --confirm-retire.`,
    exitCode: 1,
  };
}

export function renderEvidenceView(
  slug: string,
  sidecar: Sidecar,
  status: RetirementEvidenceStatus,
  trail: SidecarEmptySearch[],
  successorObservations: SidecarSuccessorObservation[],
): string {
  const lines: string[] = [`Retirement evidence for "${slug}".`];
  if (trail.length === 0) {
    lines.push('No empty searches have been recorded for this journey.');
  } else {
    lines.push('', `Empty-search trail (${trail.length} recorded, ${status.qualifyingCount} qualifying):`);
    const qualifyingSet = new Set(qualifyingEmptySearches(sidecar));
    for (const entry of trail) {
      const qualifies = qualifyingSet.has(entry);
      const stale = entry.staleSignature !== undefined;
      const subFloor = !stale && entry.sinceHours < RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS;
      const differentSignatureState = !qualifies && !stale && !subFloor;
      lines.push(
        `  - ${entry.searchedAt}: searched last ${entry.sinceHours}h in ${entry.scope} for signature "${entry.signature}"` +
        ` (Tier A: ${entry.tierACandidates}; Tier B variants: ${entry.tierBVariants})` +
        `${stale ? ' [stale signature — did not count]' : ''}` +
        `${subFloor ? ` [window below ${RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS}h floor — did not count]` : ''}` +
        `${differentSignatureState ? ' [different signature state — did not count]' : ''}` +
        `${qualifies ? ' [qualifying]' : ''}`,
      );
    }
  }
  lines.push('');
  if (status.met) {
    lines.push(`The evidence bar is met (${status.qualifyingCount} qualifying searches, spaced at least 24h apart).`);
    lines.push(`To archive this journey: \`${TOOL_NAME} retire ${slug} --confirm-retire\`.`);
  } else {
    lines.push(`The evidence bar is not yet met. ${status.unmetReason}`);
    lines.push(`The next search counts toward the bar after ${status.earliestQualifyingRerun}.`);
    lines.push(`Gather more evidence: \`${TOOL_NAME} regenerate ${slug}\`.`);
    lines.push(`To retire below the bar on operator assertion: \`${TOOL_NAME} retire ${slug} --confirm-retire --no-evidence\` (the tool records the assertion, never adopts it).`);
  }
  lines.push('', renderSuccessorObservations(successorObservations));
  return lines.join('\n');
}

export function buildNoEvidenceRequiresConfirmMessage(slug: string): string {
  return `Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar. Re-run: \`${TOOL_NAME} retire ${slug} --confirm-retire --no-evidence\`.`;
}

export function buildConfirmBarUnmetMessage(slug: string, status: RetirementEvidenceStatus): string {
  return `Refusing to retire "${slug}": the evidence bar is not met. ${status.unmetReason} Gather more evidence with \`${TOOL_NAME} regenerate ${slug}\`, or retire on operator assertion with \`${TOOL_NAME} retire ${slug} --confirm-retire --no-evidence\` (the tool records the assertion, never adopts it).`;
}

export function buildEvidenceSummary(status: RetirementEvidenceStatus, sidecar: Sidecar, evidenceBasis: 'empty-search-trail' | 'operator-asserted'): string {
  if (evidenceBasis === 'operator-asserted') return 'retired on operator assertion (evidence bar not met)';
  const qualifying = qualifyingEmptySearches(sidecar).map((entry) => entry.searchedAt).sort();
  if (qualifying.length >= 2) {
    const windowHours = Math.max(...qualifyingEmptySearches(sidecar).map((entry) => entry.sinceHours));
    return `${qualifying.length} empty searches over ${windowHours}h between ${qualifying[0]} and ${qualifying[qualifying.length - 1]}; no plannable candidate was witnessed`;
  }
  return `${status.qualifyingCount} qualifying empty searches recorded; no plannable candidate was witnessed`;
}

export function buildCompletionMessage(
  slug: string,
  archiveDir: string,
  status: RetirementEvidenceStatus,
  sidecar: Sidecar,
  evidenceBasis: 'empty-search-trail' | 'operator-asserted',
  workspaceRoot: string,
  manifestRewriteFailed: boolean,
  noEvidenceSuperfluous: boolean,
  defaultReproArchived: boolean,
  legacyPathlessDisclosure?: string,
): string {
  const archiveDisplay = `${toDisplayPath(archiveDir, workspaceRoot)}/`;
  const manifestNote = manifestRewriteFailed ? ' Note: retirement.json\'s artifact manifest could not be updated after the moves — the record lists no moved artifacts.' : '';
  const defaultReproNote = defaultReproArchived
    ? `Also archived this journey's reproduction spec: tests/reproductions/${slug}.repro.spec.ts → ${toDisplayPath(path.join(archiveDir, 'reproductions', `${slug}.repro.spec.ts`), workspaceRoot)}. (Only the default-path repro is tracked; repros written with --out stay where you put them.) `
    : '';
  const legacyNote = legacyPathlessDisclosure === undefined ? '' : ` ${legacyPathlessDisclosure}`;
  const durabilityLimits = ' Note: this tool cannot detect a write that lands at the exact moment of archiving, and if something else deletes files at the same time, the results can look like this tool\'s own partial work.';
  if (evidenceBasis === 'operator-asserted') return `Retired ${slug} (archive: ${archiveDisplay}). Retired on operator assertion (evidence bar not met). ${defaultReproNote}Keep the archive folder local to preserve the record. Restore recipe: retirement.json.${legacyNote}${durabilityLimits}${manifestNote}`;
  const summary = buildEvidenceSummary(status, sidecar, evidenceBasis);
  const superfluousNote = noEvidenceSuperfluous ? ' (The --no-evidence flag was unnecessary — the evidence bar was already met.)' : '';
  return `Retired ${slug} (archive: ${archiveDisplay}). Evidence: ${summary}. ${defaultReproNote}Keep the archive folder local to preserve the record. Restore recipe: retirement.json.${superfluousNote}${legacyNote}${durabilityLimits}${manifestNote}`;
}

export function buildPartialFailureMessage(facts: PartialFailureFacts): string {
  const lines: string[] = [`Retirement of "${facts.slug}" did not complete — a partial state was left on disk.`];
  if (facts.initialError !== undefined) lines.push(`retirement.json could not be written: ${facts.initialError}.`);
  else lines.push(`retirement.json was written to ${toDisplayPath(path.join(facts.archiveDir, 'retirement.json'), facts.workspaceRoot)}.`);
  if (facts.moved.length > 0) {
    lines.push('Moved:');
    for (const moved of facts.moved) lines.push(`  ✓ ${moved}`);
  }
  if (facts.moveFailures.length > 0) {
    lines.push('Not moved:');
    for (const failure of facts.moveFailures) lines.push(`  ✗ ${failure}`);
  }
  const okCleanup = facts.cleanupResults.filter((cleanup) => cleanup.ok);
  const failedCleanup = facts.cleanupResults.filter((cleanup) => !cleanup.ok);
  if (facts.cleanupResults.length > 0) {
    lines.push('State cleanup:');
    for (const cleanup of okCleanup) lines.push(`  ✓ ${cleanup.name}`);
    for (const cleanup of failedCleanup) lines.push(`  ✗ ${cleanup.name}${cleanup.detail === undefined ? '' : `: ${cleanup.detail}`}`);
  }
  lines.push('Manual completion steps:');
  if (facts.initialError !== undefined) {
    lines.push(`  1. Re-run \`${TOOL_NAME} retire ${facts.slug} --confirm-retire\` to retry the archival.`);
  } else {
    lines.push(`  1. Move the remaining artifacts into ${toDisplayPath(facts.archiveDir, facts.workspaceRoot)}/.`);
    if (failedCleanup.length > 0) {
      lines.push(`  2. Complete the failed cleanup steps: ${failedCleanup.map((cleanup) => cleanup.name).join(', ')}.`);
      lines.push('  3. See retirement.json for the full reversal recipe and harvested state.');
    } else lines.push('  2. See retirement.json for the full reversal recipe and harvested state.');
  }
  if (facts.specStillLive && facts.hashEntryRemoved) {
    lines.push('', `  ⚠ The spec is still live in tests/generated/${facts.slug}.spec.ts but its emitted-hash baseline was removed — preflight will report plan/spec drift as unknown. Do NOT run \`${TOOL_NAME} scaffold ${facts.slug} --force\` (it would overwrite the spec); restore the hash entry from retirement.json's harvestedState.hashEntry instead.`);
  }
  return scrubWorkspacePaths(lines.join('\n'), facts.workspaceRoot);
}

export function toDisplayPath(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

export function formatRetireResultJson(result: RetireResult): string {
  const { warnings, ...retired } = result;
  return `${JSON.stringify({ retired, ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }) }, null, 2)}\n`;
}

export function formatRetireRefusalJson(refusal: RetireRefusal): string {
  const { code, message, warnings } = refusal;
  const error = { code, message };
  return `${JSON.stringify({ error, ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }) }, null, 2)}\n`;
}

export function formatRetireEvidenceViewJson(view: RetireEvidenceView): string {
  return `${JSON.stringify({ evidence: { slug: view.slug, status: view.status, trail: view.trail, successorObservations: view.successorObservations } }, null, 2)}\n`;
}

function scrubWorkspacePaths(text: string, workspaceRoot: string): string {
  return text.split(`${workspaceRoot}${path.sep}`).join('');
}

/**
 * Left-live shapes sharing the retiring slug: pathless (legacy) OR carrying a DIFFERENT canonical
 * path — same-slug-different-path rows are deliberately never pruned (exact-equality prune rule).
 */
export function rowLeftLiveForSlug(entry: unknown, slug: string, canonical: string, slugFallback?: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const row = entry as { slug?: unknown; canonicalSpecPath?: unknown; file?: unknown };
  if ((row.slug ?? slugFallback) !== slug) return false;
  const joined = typeof row.canonicalSpecPath === 'string' ? row.canonicalSpecPath : typeof row.file === 'string' ? row.file : undefined;
  return joined === undefined || joined !== canonical;
}
