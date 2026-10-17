#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MATURITY_MS = 14 * 24 * 60 * 60 * 1_000;
const ACCEPTED_RISK_MAX_HORIZON_MS = 90 * 24 * 60 * 60 * 1_000;
const SHIM_PIN_NAMES = ['nanoid', 'postcss'];

export interface PinParentRange {
  parentName: string;
  range: string;
}

export interface ResolvedPackageInstance {
  nodePath: string;
  version?: string;
  parentRanges?: PinParentRange[];
  parentRangesKnown?: boolean;
  resolutionError?: string;
}

export interface AuditDecision {
  kind: string;
  outcome: string;
  advisoryPackage: string;
  severity: string;
  fixPackage?: string;
  fixVersion?: string;
  publishedAt?: string;
  maturesAt?: string;
  parentRanges?: PinParentRange[];
  acceptedRisk?: {
    reason: string;
    decisionRef: string;
    reviewBy: string;
  };
  reason: string;
}

export interface AcceptedRiskEntry {
  advisoryId: string;
  package: string;
  reason: string;
  decisionRef: string;
  reviewBy: string;
}

interface AuditFix {
  name: string;
  version: string;
}

interface AuditAdvisory {
  packageName: string;
  severity: string;
  fixAvailable: false | true | AuditFix;
  vulnerableRanges: string[];
  advisoryIds: string[];
  parseError?: string;
}

interface ParsedAudit {
  advisories: AuditAdvisory[];
  error?: string;
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

interface FixCandidate {
  version: string;
  publishedAt: Date;
}

interface CandidateSelection {
  candidate?: FixCandidate;
  fallbackNote?: string;
  reportReason?: string;
  toolingFailure?: string;
  rangeBlocked?: boolean;
}

interface PublishTimesResult {
  publishTimesByPkg?: Record<string, Record<string, string | undefined>>;
  error?: string;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  status?: number | null;
  /** Terminating signal, when the child was signalled (the structural SIGKILL pin reads this, not `status`). */
  signal?: NodeJS.Signals | null;
  error?: string;
}

type CommandRunner = (command: string, args: string[], cwd: string) => CommandOutput;

export interface RunAuditMaturityOptions {
  commandRunner?: CommandRunner;
  readLockfile?: (root: string) => { value?: unknown; error?: string };
  readAcceptedRisks?: (root: string) => { value?: unknown; error?: string };
  reportDecisions?: (decisions: readonly AuditDecision[]) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuditFix(value: AuditAdvisory['fixAvailable']): value is AuditFix {
  return isRecord(value) && typeof value.name === 'string' && typeof value.version === 'string';
}

function severityRank(severity: string): number | undefined {
  if (severity === 'info') return 0;
  if (severity === 'low') return 1;
  if (severity === 'moderate') return 2;
  if (severity === 'high') return 3;
  if (severity === 'critical') return 4;
  return undefined;
}

function isHighSeverity(severity: string): boolean {
  return (severityRank(severity) ?? -1) >= 3;
}

function vulnerableRangesFromVia(packageName: string, value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.via)) return [];
  return value.via.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.range !== 'string') return [];
    if (typeof entry.name === 'string' && entry.name !== packageName) return [];
    return typeof entry.severity === 'string' && isHighSeverity(entry.severity) ? [entry.range] : [];
  });
}

function advisoryIdsFromVia(packageName: string, value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.via)) return [];

  const advisoryIds = new Set<string>();
  for (const entry of value.via) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name !== packageName) continue;
    if (typeof entry.severity !== 'string' || !isHighSeverity(entry.severity)) continue;
    if (typeof entry.source === 'string' || typeof entry.source === 'number') advisoryIds.add(String(entry.source));
    if (typeof entry.url !== 'string') continue;
    const githubAdvisory = /\/advisories\/(GHSA-[A-Za-z0-9-]+)(?:[/?#]|$)/.exec(entry.url)?.[1];
    if (githubAdvisory !== undefined) advisoryIds.add(githubAdvisory);
  }
  return [...advisoryIds].sort();
}

function parseHighAdvisories(auditReport: unknown): ParsedAudit {
  if (!isRecord(auditReport) || !isRecord(auditReport.vulnerabilities)) {
    return { advisories: [], error: 'npm audit JSON has no vulnerabilities object.' };
  }

  const advisories: AuditAdvisory[] = [];
  for (const [packageName, value] of Object.entries(auditReport.vulnerabilities).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(value)) {
      advisories.push({
        packageName,
        severity: 'unknown',
        fixAvailable: false,
        vulnerableRanges: [],
        advisoryIds: [],
        parseError: `npm audit JSON has a malformed advisory for ${packageName}.`,
      });
      continue;
    }

    const severity = typeof value.severity === 'string' ? value.severity : 'unknown';
    const advisoryIds = advisoryIdsFromVia(packageName, value);
    const rank = severityRank(severity);
    if (rank === undefined) {
      advisories.push({
        packageName,
        severity,
        fixAvailable: false,
        vulnerableRanges: [],
        advisoryIds,
        parseError: `npm audit JSON has an unknown severity for ${packageName}: ${severity}.`,
      });
      continue;
    }
    if (rank < 3) continue;

    const vulnerableRanges = vulnerableRangesFromVia(packageName, value);
    if (value.fixAvailable === false || value.fixAvailable === true) {
      advisories.push({ packageName, severity, fixAvailable: value.fixAvailable, vulnerableRanges, advisoryIds });
      continue;
    }
    if (
      isRecord(value.fixAvailable) &&
      typeof value.fixAvailable.name === 'string' &&
      typeof value.fixAvailable.version === 'string'
    ) {
      advisories.push({
        packageName,
        severity,
        fixAvailable: { name: value.fixAvailable.name, version: value.fixAvailable.version },
        vulnerableRanges,
        advisoryIds,
      });
      continue;
    }
    advisories.push({
      packageName,
      severity,
      fixAvailable: false,
      vulnerableRanges,
      advisoryIds,
      parseError: `npm audit JSON has no readable fixAvailable value for ${packageName}.`,
    });
  }
  return { advisories };
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  return left.patch < right.patch ? -1 : left.patch > right.patch ? 1 : 0;
}

function parseComparator(comparator: string): { operator: string; target: SemanticVersion } | undefined {
  const match = /^(<=|>=|<|>|=)?\s*(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(comparator);
  if (match === null) return undefined;
  const target = parseSemanticVersion(match[2] ?? '');
  return target === undefined ? undefined : { operator: match[1] ?? '=', target };
}

function satisfiesComparator(version: SemanticVersion, comparator: string): boolean | undefined {
  const parsed = parseComparator(comparator);
  if (parsed === undefined) return undefined;
  const comparison = compareVersions(version, parsed.target);
  if (parsed.operator === '<') return comparison < 0;
  if (parsed.operator === '<=') return comparison <= 0;
  if (parsed.operator === '>') return comparison > 0;
  if (parsed.operator === '>=') return comparison >= 0;
  return comparison === 0;
}

function rangeClauseIsParseable(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed === '' || trimmed === '*') return true;

  const caret = /^\^(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(trimmed)?.[1];
  if (caret !== undefined) return parseSemanticVersion(caret) !== undefined;
  const tilde = /^~(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(trimmed)?.[1];
  if (tilde !== undefined) return parseSemanticVersion(tilde) !== undefined;

  const comparators = trimmed.split(/\s+/);
  return comparators.length > 0 && comparators.every((comparator) => parseComparator(comparator) !== undefined);
}

function rangeIsParseable(range: string): boolean {
  const clauses = range.split('||');
  return clauses.length > 0 && clauses.every(rangeClauseIsParseable);
}

function satisfiesRangeClause(version: SemanticVersion, clause: string): boolean | undefined {
  const trimmed = clause.trim();
  if (trimmed === '' || trimmed === '*') return true;

  const caret = /^\^(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(trimmed)?.[1];
  if (caret !== undefined) {
    const minimum = parseSemanticVersion(caret);
    if (minimum === undefined) return undefined;
    if (compareVersions(version, minimum) < 0) return false;
    const maximum = minimum.major > 0
      ? { major: minimum.major + 1, minor: 0, patch: 0 }
      : minimum.minor > 0
        ? { major: 0, minor: minimum.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: minimum.patch + 1 };
    return compareVersions(version, maximum) < 0;
  }

  const tilde = /^~(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(trimmed)?.[1];
  if (tilde !== undefined) {
    const minimum = parseSemanticVersion(tilde);
    if (minimum === undefined) return undefined;
    if (compareVersions(version, minimum) < 0) return false;
    return compareVersions(version, { major: minimum.major, minor: minimum.minor + 1, patch: 0 }) < 0;
  }

  const comparators = trimmed.split(/\s+/).map((part) => satisfiesComparator(version, part));
  if (comparators.some((result) => result === undefined)) return undefined;
  return comparators.length > 0 && comparators.every((result) => result === true);
}

function rangeSatisfaction(range: string, version: string): boolean | undefined {
  const parsedVersion = parseSemanticVersion(version);
  if (parsedVersion === undefined || !rangeIsParseable(range)) return undefined;
  const results = range.split('||').map((clause) => satisfiesRangeClause(parsedVersion, clause));
  return results.some((result) => result === true);
}

/** The lockfile only uses ordinary npm ranges here; unsupported syntax is conservatively not admitted. */
export function rangeAdmitsVersion(range: string, version: string): boolean {
  return rangeSatisfaction(range, version) === true;
}

function invalidDecision(reason: string): AuditDecision {
  return {
    kind: 'invalid-audit',
    outcome: 'tooling-failure',
    advisoryPackage: 'npm audit',
    severity: 'unknown',
    reason,
  };
}

function toolingFailureDecision(advisory: AuditAdvisory, reason: string): AuditDecision {
  return {
    kind: 'tooling-failure',
    outcome: 'tooling-failure',
    advisoryPackage: advisory.packageName,
    severity: advisory.severity,
    reason,
  };
}

function publishedCandidate(
  publishTimes: Readonly<Record<string, string | undefined>> | undefined,
  version: string,
): FixCandidate | undefined {
  const published = publishTimes?.[version];
  const publishedAt = typeof published === 'string' ? new Date(published) : undefined;
  return publishedAt !== undefined && Number.isFinite(publishedAt.getTime()) ? { version, publishedAt } : undefined;
}

function hasUsablePublishTimes(
  publishTimes: Readonly<Record<string, string | undefined>> | undefined,
): publishTimes is Readonly<Record<string, string | undefined>> {
  return publishTimes !== undefined && Object.entries(publishTimes).some(([version, published]) =>
    parseSemanticVersion(version) !== undefined &&
    typeof published === 'string' &&
    Number.isFinite(new Date(published).getTime()),
  );
}

function vulnerableRangesAreParseable(ranges: readonly string[]): boolean {
  return ranges.length > 0 && ranges.every(rangeIsParseable);
}

function resolvedVersionIsVulnerable(resolvedVersion: string, ranges: readonly string[]): boolean {
  return ranges.some((range) => rangeSatisfaction(range, resolvedVersion) === true);
}

function compareCandidateVersions(left: FixCandidate, right: FixCandidate): number {
  const leftVersion = parseSemanticVersion(left.version);
  const rightVersion = parseSemanticVersion(right.version);
  if (leftVersion === undefined || rightVersion === undefined) return left.version.localeCompare(right.version);
  return compareVersions(leftVersion, rightVersion);
}

function smallestSafeCandidate(
  publishTimes: Readonly<Record<string, string | undefined>>,
  resolvedVersion: string,
  ranges: readonly string[],
  parentRanges: readonly PinParentRange[] | undefined = undefined,
): FixCandidate | undefined {
  const resolved = parseSemanticVersion(resolvedVersion);
  if (resolved === undefined) return undefined;

  const candidates: FixCandidate[] = [];
  for (const [version, published] of Object.entries(publishTimes)) {
    const parsedVersion = parseSemanticVersion(version);
    if (parsedVersion === undefined || compareVersions(parsedVersion, resolved) < 0) continue;
    if (ranges.some((range) => rangeSatisfaction(range, version) !== false)) continue;
    if (parentRanges !== undefined && parentRanges.some((parent) => !rangeAdmitsVersion(parent.range, version))) continue;
    const publishedAt = new Date(published ?? '');
    if (Number.isFinite(publishedAt.getTime())) candidates.push({ version, publishedAt });
  }
  return candidates.sort(compareCandidateVersions)[0];
}

function fixAvailableHint(advisory: AuditAdvisory): string {
  if (isAuditFix(advisory.fixAvailable) && advisory.fixAvailable.name !== advisory.packageName) {
    return ` npm audit indicates that the take is via ${advisory.fixAvailable.name}@${advisory.fixAvailable.version}.`;
  }
  return '';
}

function selectFixCandidate(
  advisory: AuditAdvisory,
  publishTimes: Readonly<Record<string, string | undefined>> | undefined,
  resolvedVersion: string,
  parentRanges: readonly PinParentRange[] | undefined,
): CandidateSelection {
  if (!hasUsablePublishTimes(publishTimes)) {
    return { toolingFailure: `Could not determine usable publish times for ${advisory.packageName}.` };
  }
  if (!vulnerableRangesAreParseable(advisory.vulnerableRanges)) {
    const fallbackNote = 'Vulnerable range was missing or unparseable; falling back to npm audit fixAvailable.version.';
    if (!isAuditFix(advisory.fixAvailable) || advisory.fixAvailable.name !== advisory.packageName) {
      return {
        reportReason: `${fallbackNote} npm audit did not provide an advisory-package fix version to use safely.${fixAvailableHint(advisory)}`,
      };
    }
    const fallback = publishedCandidate(publishTimes, advisory.fixAvailable.version);
    if (fallback === undefined) {
      return { toolingFailure: `Could not determine when ${advisory.packageName}@${advisory.fixAvailable.version} was published.` };
    }
    if (parentRanges !== undefined && parentRanges.some((parent) => !rangeAdmitsVersion(parent.range, fallback.version))) {
      return { candidate: fallback, fallbackNote, rangeBlocked: true };
    }
    return { candidate: fallback, fallbackNote };
  }

  const candidate = smallestSafeCandidate(publishTimes, resolvedVersion, advisory.vulnerableRanges);
  if (candidate === undefined) {
    return {
      reportReason: `No published non-prerelease fix at or above ${advisory.packageName}@${resolvedVersion} clears the vulnerable range yet.${fixAvailableHint(advisory)}`,
    };
  }
  if (parentRanges === undefined || parentRanges.length === 0 || parentRanges.every((parent) => rangeAdmitsVersion(parent.range, candidate.version))) {
    return { candidate };
  }
  const parentAdmittedCandidate = smallestSafeCandidate(publishTimes, resolvedVersion, advisory.vulnerableRanges, parentRanges);
  if (parentAdmittedCandidate !== undefined) return { candidate: parentAdmittedCandidate };
  return { candidate, rangeBlocked: true };
}

function decisionForCandidate(
  advisory: AuditAdvisory,
  candidate: FixCandidate,
  now: Date,
  parentRanges: readonly PinParentRange[] | undefined,
  fallbackNote: string | undefined,
  rangeBlocked: boolean | undefined,
): AuditDecision {
  const publishedAt = candidate.publishedAt.toISOString();
  const maturesAt = new Date(candidate.publishedAt.getTime() + MATURITY_MS).toISOString();
  const note = `${fallbackNote === undefined ? '' : ` ${fallbackNote}`}${fixAvailableHint(advisory)}`;
  if (rangeBlocked) {
    const parents = parentRanges?.map((parent) => `${parent.parentName} (${parent.range})`).join(', ') ?? 'unknown parent range';
    return {
      kind: 'shim-range-blocked',
      outcome: 'report',
      advisoryPackage: advisory.packageName,
      severity: advisory.severity,
      fixPackage: advisory.packageName,
      fixVersion: candidate.version,
      publishedAt,
      maturesAt,
      parentRanges: parentRanges === undefined ? undefined : [...parentRanges],
      reason: `${advisory.packageName}@${candidate.version} is the smallest clearing fix, but no declaring parent range admits any clearing version (${parents}). Update the declaring parent dependency to a version that admits a clearing fix.${note}`,
    };
  }
  if (now.getTime() < Date.parse(maturesAt)) {
    return {
      kind: 'immature-fix',
      outcome: 'report',
      advisoryPackage: advisory.packageName,
      severity: advisory.severity,
      fixPackage: advisory.packageName,
      fixVersion: candidate.version,
      publishedAt,
      maturesAt,
      reason: `${advisory.packageName}@${candidate.version} matures on ${maturesAt}.${note}`,
    };
  }
  return {
    kind: 'mature-untaken',
    outcome: 'fail',
    advisoryPackage: advisory.packageName,
    severity: advisory.severity,
    fixPackage: advisory.packageName,
    fixVersion: candidate.version,
    publishedAt,
    maturesAt,
    reason: `${advisory.packageName}@${candidate.version} has been mature since ${maturesAt} and the lockfile still resolves a vulnerable version.${note}`,
  };
}

function parentRangesForInstance(
  advisory: AuditAdvisory,
  instance: ResolvedPackageInstance,
  pinParentRanges: Readonly<Record<string, readonly PinParentRange[] | undefined>>,
): readonly PinParentRange[] | undefined {
  if (!SHIM_PIN_NAMES.includes(advisory.packageName)) return undefined;
  return instance.parentRangesKnown ? instance.parentRanges : pinParentRanges[advisory.packageName];
}

interface ResolvedVersionedInstance extends ResolvedPackageInstance {
  version: string;
}

function unreadableOrNoFixDecision(advisory: AuditAdvisory): AuditDecision | undefined {
  if (advisory.parseError !== undefined) {
    return toolingFailureDecision(advisory, advisory.parseError);
  }
  if (advisory.fixAvailable !== false) return undefined;
  return {
    kind: 'no-fix',
    outcome: 'report',
    advisoryPackage: advisory.packageName,
    severity: advisory.severity,
    reason: `${advisory.packageName} has no fixed version available.`,
  };
}

function readableInstancesForAdvisory(
  advisory: AuditAdvisory,
  resolvedVersions: Readonly<Record<string, readonly ResolvedPackageInstance[] | undefined>>,
): { instances?: readonly ResolvedVersionedInstance[]; decision?: AuditDecision } {
  const instances = resolvedVersions[advisory.packageName];
  if (instances === undefined || instances.length === 0) {
    return { decision: toolingFailureDecision(advisory, `Could not resolve any lockfile nodes for ${advisory.packageName}.`) };
  }
  const unresolved = instances.find((instance) =>
    instance.resolutionError !== undefined || instance.version === undefined || parseSemanticVersion(instance.version) === undefined,
  );
  if (unresolved !== undefined) {
    return {
      decision: toolingFailureDecision(
        advisory,
        unresolved.resolutionError ?? `Could not read a semver lockfile resolution for ${advisory.packageName} at ${unresolved.nodePath}.`,
      ),
    };
  }
  return { instances: instances as readonly ResolvedVersionedInstance[] };
}

function noLongerVulnerableDecision(advisory: AuditAdvisory): AuditDecision {
  return {
    kind: 'not-actionable',
    outcome: 'report',
    advisoryPackage: advisory.packageName,
    severity: advisory.severity,
    reason: `${advisory.packageName} lockfile instances no longer satisfy the audit advisory's vulnerable range.`,
  };
}

function reportSelectionDecision(advisory: AuditAdvisory, selection: CandidateSelection): AuditDecision {
  return {
    kind: 'not-actionable',
    outcome: 'report',
    advisoryPackage: advisory.packageName,
    severity: advisory.severity,
    fixPackage: isAuditFix(advisory.fixAvailable) ? advisory.fixAvailable.name : undefined,
    fixVersion: isAuditFix(advisory.fixAvailable) ? advisory.fixAvailable.version : undefined,
    reason: selection.reportReason ?? 'Could not select a safe fixed version.',
  };
}

function decisionFromSelections(
  advisory: AuditAdvisory,
  selections: readonly CandidateSelection[],
  vulnerableInstances: readonly ResolvedVersionedInstance[],
  now: Date,
  pinParentRanges: Readonly<Record<string, readonly PinParentRange[] | undefined>>,
): AuditDecision {
  const decisionsByInstance = selections.map((selection, index) => {
    const instance = vulnerableInstances[index];
    if (instance === undefined) return toolingFailureDecision(advisory, 'Could not match a fix selection to its vulnerable lockfile instance.');
    const decision = selection.toolingFailure !== undefined
      ? toolingFailureDecision(advisory, selection.toolingFailure)
      : selection.reportReason !== undefined || selection.candidate === undefined
        ? reportSelectionDecision(advisory, selection)
        : decisionForCandidate(advisory, selection.candidate, now, parentRangesForInstance(advisory, instance, pinParentRanges), selection.fallbackNote, selection.rangeBlocked);
    return { ...decision, reason: `${instance.nodePath}: ${decision.reason}` };
  });
  const informational = decisionsByInstance.reduce<AuditDecision | undefined>((mostUrgent, decision) => {
    if (decision.outcome !== 'report') return mostUrgent;
    const urgency = decision.kind === 'shim-range-blocked' ? 0 : decision.kind === 'immature-fix' ? Date.parse(decision.maturesAt ?? '') : Number.POSITIVE_INFINITY;
    const selectedUrgency = mostUrgent?.kind === 'shim-range-blocked' ? 0 : mostUrgent?.kind === 'immature-fix' ? Date.parse(mostUrgent.maturesAt ?? '') : Number.POSITIVE_INFINITY;
    return mostUrgent === undefined || urgency < selectedUrgency ? decision : mostUrgent;
  }, undefined);
  const primary = decisionsByInstance.find((decision) => decision.outcome === 'fail')
    ?? decisionsByInstance.find((decision) => decision.outcome === 'tooling-failure')
    ?? informational;
  if (primary === undefined) return toolingFailureDecision(advisory, 'Could not classify a clearing package version.');
  const siblingNotes = decisionsByInstance.filter((decision) => decision !== primary).map((decision) => decision.reason);
  return siblingNotes.length === 0
    ? primary
    : { ...primary, reason: `${primary.reason} Other vulnerable lockfile instances: ${siblingNotes.join(' ')}` };
}

function classifyAdvisory(
  advisory: AuditAdvisory,
  publishTimesByPkg: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>,
  now: Date,
  pinParentRanges: Readonly<Record<string, readonly PinParentRange[] | undefined>>,
  resolvedVersions: Readonly<Record<string, readonly ResolvedPackageInstance[] | undefined>>,
): AuditDecision {
  const immediateDecision = unreadableOrNoFixDecision(advisory);
  if (immediateDecision !== undefined) return immediateDecision;

  const readable = readableInstancesForAdvisory(advisory, resolvedVersions);
  if (readable.decision !== undefined || readable.instances === undefined) {
    return readable.decision ?? toolingFailureDecision(advisory, 'Could not read lockfile package instances.');
  }
  const vulnerableInstances = vulnerableRangesAreParseable(advisory.vulnerableRanges)
    ? readable.instances.filter((instance) => resolvedVersionIsVulnerable(instance.version, advisory.vulnerableRanges))
    : readable.instances;
  if (vulnerableInstances.length === 0) return noLongerVulnerableDecision(advisory);

  const selections = vulnerableInstances.map((instance) => selectFixCandidate(
    advisory,
    publishTimesByPkg[advisory.packageName],
    instance.version,
    parentRangesForInstance(advisory, instance, pinParentRanges),
  ));
  return decisionFromSelections(advisory, selections, vulnerableInstances, now, pinParentRanges);
}

function matchingAcceptedRisks(
  advisory: AuditAdvisory,
  acceptedRisks: readonly AcceptedRiskEntry[],
): AcceptedRiskEntry[] {
  return acceptedRisks.filter((entry) =>
    entry.package === advisory.packageName && advisory.advisoryIds.includes(entry.advisoryId),
  );
}

function applyAcceptedRisk(
  decision: AuditDecision,
  advisory: AuditAdvisory,
  acceptedRisks: readonly AcceptedRiskEntry[],
  now: Date,
): AuditDecision {
  const matching = matchingAcceptedRisks(advisory, acceptedRisks);
  if (matching.length === 0) return decision;
  const active = matching.find((entry) => Date.parse(entry.reviewBy) > now.getTime());

  if (decision.outcome !== 'fail') {
    const noted = active ?? matching[0];
    if (noted === undefined) return decision;
    return {
      ...decision,
      reason: `${decision.reason} accepted-risk entry present (advisory currently ${decision.kind}; re-review by ${noted.reviewBy}).`,
    };
  }

  if (active !== undefined) {
    return {
      ...decision,
      kind: 'accepted-risk',
      outcome: 'accepted-risk',
      acceptedRisk: {
        reason: active.reason,
        decisionRef: active.decisionRef,
        reviewBy: active.reviewBy,
      },
      reason: `${active.reason} See ${active.decisionRef}. ${decision.reason}`,
    };
  }

  const expired = matching.find((entry) => Date.parse(entry.reviewBy) <= now.getTime());
  if (expired === undefined) return decision;
  return {
    ...decision,
    reason: `${decision.reason} accepted-risk entry EXPIRED ${expired.reviewBy}.`,
  };
}

/**
 * Classifies high/critical npm audit advisories without performing I/O. The
 * shell supplies registry publish times and lockfile-derived parent ranges so
 * fixtures can exercise every outcome without touching the network.
 */
export function classifyAuditMaturity(
  auditReport: unknown,
  publishTimesByPkg: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>,
  now: Date,
  pinParentRanges: Readonly<Record<string, readonly PinParentRange[] | undefined>>,
  resolvedVersions: Readonly<Record<string, readonly ResolvedPackageInstance[] | undefined>> = {},
  acceptedRisks: readonly AcceptedRiskEntry[] = [],
): AuditDecision[] {
  const parsed = parseHighAdvisories(auditReport);
  if (parsed.error !== undefined) return [invalidDecision(parsed.error)];
  if (!Number.isFinite(now.getTime())) return [invalidDecision('The maturity clock is invalid.')];

  const decisions = parsed.advisories.map((advisory) => applyAcceptedRisk(
    classifyAdvisory(advisory, publishTimesByPkg, now, pinParentRanges, resolvedVersions),
    advisory,
    acceptedRisks,
    now,
  ));
  const unmatchedAcceptedRisks = acceptedRisks.filter((entry) => !parsed.advisories.some((advisory) =>
    entry.package === advisory.packageName && advisory.advisoryIds.includes(entry.advisoryId),
  ));
  return [
    ...decisions,
    ...unmatchedAcceptedRisks.map((entry) => ({
      kind: 'accepted-risk-unmatched',
      outcome: 'report',
      advisoryPackage: entry.package,
      severity: 'unknown',
      reason: `accepted-risk entry ${entry.advisoryId} matches no current advisory — remove or update it`,
    })),
  ];
}

function registryPackagesFromAudit(auditReport: unknown): { packageNames: string[]; error?: string } {
  const parsed = parseHighAdvisories(auditReport);
  if (parsed.error !== undefined) return { packageNames: [], error: parsed.error };
  return {
    packageNames: [...new Set(parsed.advisories.flatMap((advisory) =>
      advisory.parseError !== undefined || advisory.fixAvailable === false ? [] : [advisory.packageName],
    ))].sort(),
  };
}

function declaredRanges(manifest: Record<string, unknown>, packageName: string): string[] {
  const ranges: string[] = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!isRecord(manifest[field])) continue;
    const range = manifest[field][packageName];
    if (typeof range === 'string') ranges.push(range);
  }
  return ranges;
}

function dependencyNodePaths(packagePath: string, packageName: string): string[] {
  const candidates: string[] = [];
  let current = packagePath;
  while (true) {
    candidates.push(current === '' ? `node_modules/${packageName}` : `${current}/node_modules/${packageName}`);
    if (current === '') return candidates;
    const boundary = current.lastIndexOf('/node_modules/');
    current = boundary === -1 ? '' : current.slice(0, boundary);
  }
}

function dependencyResolvesToNode(lockfile: unknown, packagePath: string, packageName: string, nodePath: string): boolean {
  if (!isRecord(lockfile)) return false;
  const packages = lockfile.packages;
  if (!isRecord(packages)) return false;
  const resolvedPath = dependencyNodePaths(packagePath, packageName).find((candidate) => isRecord(packages[candidate]));
  return resolvedPath === nodePath;
}

function parentRangesForNode(lockfile: unknown, packageName: string, nodePath: string): PinParentRange[] {
  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) return [];
  const parents: PinParentRange[] = [];
  for (const [packagePath, manifest] of Object.entries(lockfile.packages)) {
    // The root is an exact pin, not a declaring package: including it would permanently block the shim rider.
    if (packagePath === '' || !isRecord(manifest) || !dependencyResolvesToNode(lockfile, packagePath, packageName, nodePath)) continue;
    for (const range of declaredRanges(manifest, packageName)) parents.push({ parentName: packagePath, range });
  }
  return parents.sort((left, right) => left.parentName.localeCompare(right.parentName) || left.range.localeCompare(right.range));
}

/** Resolves shim parents from lockfile declarations; only the named direct pins get the coherence rider. */
export function pinParentRangesFromLockfile(lockfile: unknown): Record<string, PinParentRange[]> {
  const result: Record<string, PinParentRange[]> = {};
  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) return result;

  for (const pinName of SHIM_PIN_NAMES) {
    const parents: PinParentRange[] = [];
    for (const [packagePath, manifest] of Object.entries(lockfile.packages)) {
      // See parentRangesForNode: root pins must not make the shim rider permanently range-blocked.
      if (packagePath === '' || !isRecord(manifest)) continue;
      for (const range of declaredRanges(manifest, pinName)) parents.push({ parentName: packagePath, range });
    }
    if (parents.length > 0) result[pinName] = parents.sort((left, right) => left.parentName.localeCompare(right.parentName) || left.range.localeCompare(right.range));
  }
  return result;
}

/** Reads every exact resolved package version from npm audit's lockfile node paths, never node_modules. */
export function resolvedVersionsFromLockfile(
  auditReport: unknown,
  lockfile: unknown,
): Record<string, ResolvedPackageInstance[]> {
  const result: Record<string, ResolvedPackageInstance[]> = {};
  if (!isRecord(auditReport) || !isRecord(auditReport.vulnerabilities) || !isRecord(lockfile)) {
    return result;
  }
  const packages = lockfile.packages;
  if (!isRecord(packages)) return result;
  for (const [packageName, advisory] of Object.entries(auditReport.vulnerabilities)) {
    if (!isRecord(advisory)) continue;
    const nodes = Array.isArray(advisory.nodes) && advisory.nodes.every((node) => typeof node === 'string')
      ? [...new Set(advisory.nodes)]
      : [];
    if (nodes.length === 0) {
      result[packageName] = [{
        nodePath: '(no npm audit node)',
        resolutionError: `npm audit reported no resolvable lockfile nodes for ${packageName}.`,
      }];
      continue;
    }
    result[packageName] = nodes.map((nodePath) => {
      const manifest = packages[nodePath];
      if (!isRecord(manifest) || typeof manifest.version !== 'string') {
        return {
          nodePath,
          resolutionError: `Could not read ${packageName}'s lockfile resolution at ${nodePath}.`,
        };
      }
      const parentRanges = SHIM_PIN_NAMES.includes(packageName)
        ? parentRangesForNode(lockfile, packageName, nodePath)
        : undefined;
      return {
        nodePath,
        version: manifest.version,
        parentRanges,
        parentRangesKnown: SHIM_PIN_NAMES.includes(packageName),
      };
    });
  }
  return result;
}

function parseJson(text: string, label: string): { value?: unknown; error?: string } {
  if (text.trim() === '') return { error: `${label} returned no JSON.` };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${label} returned malformed JSON (${message}).` };
  }
}

function parseReviewBy(value: string): number | undefined {
  const isIsoDate = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value);
  if (!isIsoDate) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseAcceptedRisks(value: unknown, now: Date): { value?: AcceptedRiskEntry[]; error?: string } {
  const label = 'scripts/maintenance/audit-accepted-risks.json';
  if (!isRecord(value) || !Array.isArray(value.acceptedRisks)) {
    return { error: `${label} must contain an object with an acceptedRisks array.` };
  }

  const requiredFields = ['advisoryId', 'package', 'reason', 'decisionRef', 'reviewBy'] as const;
  const acceptedRisks: AcceptedRiskEntry[] = [];
  for (const [index, entry] of value.acceptedRisks.entries()) {
    if (!isRecord(entry)) return { error: `${label} entry ${index} must be an object.` };
    const missingField = requiredFields.find((field) => typeof entry[field] !== 'string' || entry[field].trim() === '');
    if (missingField !== undefined) return { error: `${label} entry ${index} is missing required field ${missingField}.` };

    const acceptedRisk: AcceptedRiskEntry = {
      advisoryId: entry.advisoryId as string,
      package: entry.package as string,
      reason: entry.reason as string,
      decisionRef: entry.decisionRef as string,
      reviewBy: entry.reviewBy as string,
    };
    const reviewBy = parseReviewBy(acceptedRisk.reviewBy);
    if (reviewBy === undefined) {
      return { error: `${label} entry ${index} has an invalid reviewBy ISO date.` };
    }
    if (Number.isFinite(now.getTime()) && reviewBy > now.getTime() + ACCEPTED_RISK_MAX_HORIZON_MS) {
      return { error: `${label} entry ${index} reviewBy is more than 90 days from the run time; the 90-day policy keeps expiry meaningful.` };
    }
    acceptedRisks.push(acceptedRisk);
  }
  return { value: acceptedRisks };
}

function readAcceptedRisksFile(root: string): { value?: unknown; error?: string } {
  const risksPath = path.join(root, 'scripts/maintenance/audit-accepted-risks.json');
  try {
    return parseJson(fs.readFileSync(risksPath, 'utf8'), risksPath);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { value: { acceptedRisks: [] } };
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Could not read ${risksPath} (${message}).` };
  }
}

function readLockfile(root: string): { value?: unknown; error?: string } {
  const lockfilePath = path.join(root, 'package-lock.json');
  try {
    return parseJson(fs.readFileSync(lockfilePath, 'utf8'), lockfilePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Could not read ${lockfilePath} (${message}).` };
  }
}

function stringProperties(record: Readonly<Record<string, unknown>>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function decisionSummary(decisions: readonly AuditDecision[]): string {
  const rows = decisions.length === 0
    ? ['| PASS | — | — | No high or critical advisories reported. |']
    : decisions.map((decision) => {
      const fix = decision.fixPackage === undefined ? '—' : `${decision.fixPackage}@${decision.fixVersion ?? '?'}`;
      const outcome = decision.acceptedRisk === undefined
        ? decision.outcome.toUpperCase()
        : `ACCEPTED-RISK (re-review by ${decision.acceptedRisk.reviewBy})`;
      return `| ${outcome} | ${decision.advisoryPackage} | ${fix} | ${decision.reason.replaceAll('|', '\\|')} |`;
    });
  return ['## Audit maturity', '', '| Result | Advisory | Fix | Detail |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
}

function reportDecisions(decisions: readonly AuditDecision[]): boolean {
  if (decisions.length === 0) {
    console.log('[audit-maturity] PASS: npm audit reported no high or critical advisories.');
  } else {
    for (const decision of decisions) {
      const outcome = decision.acceptedRisk === undefined
        ? decision.outcome.toUpperCase()
        : `ACCEPTED-RISK (re-review by ${decision.acceptedRisk.reviewBy})`;
      console.log(`[audit-maturity] ${outcome}: ${decision.reason}`);
    }
  }
  const summary = decisionSummary(decisions);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY === undefined) return true;
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[audit-maturity] TOOLING-FAILURE: Could not write GITHUB_STEP_SUMMARY (${message}).`);
    return false;
  }
}

/** Same wall-clock and output budgets as the PostHog provider CLI: registry work must fail loud, never hang. */
export const AUDIT_COMMAND_TIMEOUT_MS = 120_000;
export const AUDIT_COMMAND_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

// CI runs on Linux/macOS, where the npm executable is named npm (Windows would require npm.cmd).
// `timeoutMs` is a test seam; production always uses AUDIT_COMMAND_TIMEOUT_MS.
export function commandOutput(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = AUDIT_COMMAND_TIMEOUT_MS,
): CommandOutput {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: AUDIT_COMMAND_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error !== undefined) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    const failure = errorCode === 'ETIMEDOUT'
      ? `${command} ${args.join(' ')} timed out after ${(timeoutMs / 1_000).toFixed(1)}s; check npm registry connectivity, then rerun the audit job.`
      : result.error.message;
    return { stdout: '', stderr: '', status: result.status, signal: result.signal, error: failure };
  }
  // npm audit exits nonzero when vulnerabilities exist; that status is data, not a tooling failure.
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), status: result.status, signal: result.signal };
}

function readPublishTimes(
  packageNames: readonly string[],
  root: string,
  runCommand: CommandRunner,
): PublishTimesResult {
  const publishTimesByPkg: Record<string, Record<string, string | undefined>> = {};
  for (const packageName of packageNames) {
    let lastError = 'unknown npm view failure';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      console.log(attempt === 0
        ? `[audit-maturity] Fetching publish times for ${packageName}...`
        : `[audit-maturity] Retrying publish times for ${packageName}...`);
      const metadata = runCommand('npm', ['view', packageName, 'time', '--json'], root);
      if (metadata.error !== undefined) {
        lastError = metadata.error;
        continue;
      }
      if (metadata.status !== 0) {
        lastError = `npm view exited ${String(metadata.status)}${metadata.stderr.trim() === '' ? '' : ` (${metadata.stderr.trim()})`}`;
        continue;
      }
      const parsedMetadata = parseJson(metadata.stdout, `npm view ${packageName} time --json`);
      if (parsedMetadata.error !== undefined || !isRecord(parsedMetadata.value)) {
        lastError = parsedMetadata.error ?? `npm view ${packageName} time --json returned no object.`;
        continue;
      }
      const times = stringProperties(parsedMetadata.value);
      if (!hasUsablePublishTimes(times)) {
        lastError = `npm view ${packageName} time --json returned no usable semver publish times.`;
        continue;
      }
      publishTimesByPkg[packageName] = times;
      lastError = '';
      break;
    }
    if (lastError !== '') return { error: `Could not read publish times for ${packageName} after one retry (${lastError}).` };
  }
  return { publishTimesByPkg };
}

function failsBuild(decision: AuditDecision): boolean {
  return decision.outcome === 'fail' || decision.outcome === 'tooling-failure';
}

function exitCodeForDecisions(decisions: readonly AuditDecision[], summaryWritten: boolean): number {
  return !summaryWritten || decisions.some(failsBuild) ? 1 : 0;
}

function readAuditReport(root: string, runCommand: CommandRunner): { value?: unknown; error?: string } {
  console.log('[audit-maturity] Running npm audit --json against package-lock.json...');
  const audit = runCommand('npm', ['audit', '--json'], root);
  if (audit.error !== undefined) return { error: `Could not run npm audit --json (${audit.error}).` };
  return parseJson(audit.stdout, 'npm audit --json');
}

interface ClassificationInputs {
  publishTimesByPkg: Record<string, Record<string, string | undefined>>;
  lockfile: unknown;
}

function readClassificationInputs(
  auditReport: unknown,
  root: string,
  runCommand: CommandRunner,
  loadLockfile: (root: string) => { value?: unknown; error?: string },
): { value?: ClassificationInputs; error?: string } {
  const targets = registryPackagesFromAudit(auditReport);
  if (targets.error !== undefined) return { error: targets.error };

  const publishTimes = readPublishTimes(targets.packageNames, root, runCommand);
  if (publishTimes.error !== undefined || publishTimes.publishTimesByPkg === undefined) {
    return { error: publishTimes.error ?? 'Could not read fix publish times.' };
  }

  const lockfile = loadLockfile(root);
  if (lockfile.error !== undefined || lockfile.value === undefined) {
    return { error: lockfile.error ?? 'Could not read package-lock.json.' };
  }
  return { value: { publishTimesByPkg: publishTimes.publishTimesByPkg, lockfile: lockfile.value } };
}

function reportFailure(emit: (decisions: readonly AuditDecision[]) => boolean, reason: string): number {
  emit([invalidDecision(reason)]);
  return 1;
}

function acceptedRiskFailure(reason: string): AuditDecision {
  return {
    kind: 'tooling-failure',
    outcome: 'tooling-failure',
    advisoryPackage: 'audit-accepted-risks.json',
    severity: 'unknown',
    reason,
  };
}

type AcceptedRiskLoad =
  | { acceptedRisks: AcceptedRiskEntry[] }
  | { failure: AuditDecision };

function loadAcceptedRisksForRun(
  root: string,
  now: Date,
  readAcceptedRisks: (root: string) => { value?: unknown; error?: string } = readAcceptedRisksFile,
): AcceptedRiskLoad {
  const acceptedRiskFile = readAcceptedRisks(root);
  if (acceptedRiskFile.error !== undefined || acceptedRiskFile.value === undefined) {
    return { failure: acceptedRiskFailure(acceptedRiskFile.error ?? 'Could not read accepted-risk entries.') };
  }
  const acceptedRisks = parseAcceptedRisks(acceptedRiskFile.value, now);
  if (acceptedRisks.error !== undefined || acceptedRisks.value === undefined) {
    return { failure: acceptedRiskFailure(acceptedRisks.error ?? 'Could not parse accepted-risk entries.') };
  }
  return { acceptedRisks: acceptedRisks.value };
}

/** Runs npm audit plus only the package-metadata lookups needed for high/critical fixes. */
export function runAuditMaturity(
  root = process.cwd(),
  now = new Date(),
  options: RunAuditMaturityOptions = {},
): number {
  const runCommand = options.commandRunner ?? commandOutput;
  const emit = options.reportDecisions ?? reportDecisions;
  const loadLockfile = options.readLockfile ?? readLockfile;
  const acceptedRiskLoad = loadAcceptedRisksForRun(root, now, options.readAcceptedRisks);
  if ('failure' in acceptedRiskLoad) {
    emit([acceptedRiskLoad.failure]);
    return 1;
  }

  const parsedAudit = readAuditReport(root, runCommand);
  if (parsedAudit.error !== undefined || parsedAudit.value === undefined) {
    return reportFailure(emit, parsedAudit.error ?? 'npm audit --json returned no report.');
  }
  const inputs = readClassificationInputs(parsedAudit.value, root, runCommand, loadLockfile);
  if (inputs.error !== undefined || inputs.value === undefined) {
    return reportFailure(emit, inputs.error ?? 'Could not prepare audit maturity inputs.');
  }

  const decisions = classifyAuditMaturity(
    parsedAudit.value,
    inputs.value.publishTimesByPkg,
    now,
    pinParentRangesFromLockfile(inputs.value.lockfile),
    resolvedVersionsFromLockfile(parsedAudit.value, inputs.value.lockfile),
    acceptedRiskLoad.acceptedRisks,
  );
  const summaryWritten = emit(decisions);
  return exitCodeForDecisions(decisions, summaryWritten);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) {
  process.exitCode = runAuditMaturity();
}
