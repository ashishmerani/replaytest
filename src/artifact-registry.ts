/**
 * Product artifact classes emitted into customer workspaces.
 *
 * This registry deliberately excludes development-internal outputs such as
 * eval-harness reports and temporary probes. The typed emit chokepoint covers
 * filesystem artifacts only; stdout envelopes and dashboard HTTP payloads are
 * registered here for coverage mapping but intentionally remain outside it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIVACY_DISCLOSURE_REQUIRED_COPY, type PrivacyDisclosure } from './pii-lint.js';

export type GuardDisposition =
  | 'golden-frozen'
  | 'scripted-battery'
  | 'unit-only'
  | 'deliberately-unguarded';

export type EvidenceMode = 'offline-coverable' | 'live-gated' | 'socket';

/** How the privacy boundary treats an artifact class. */
export type PrivacyDisposition =
  | 'disclose'
  | 'block-override'
  | 'declared-sensitive'
  | 'seam-only'
  | 'rename-seam';

export interface ArtifactPrivacyOptions {
  /** Structured disclosure produced before the renderer/write seam. */
  privacyDisclosure?: PrivacyDisclosure;
  /** Per-invocation consent for a block-class artifact. */
  allowPrivacyDisclosure?: boolean;
}

type NonEmptyReadonlyArray<Item> = readonly [Item, ...Item[]];

type GuardedArtifactRegistryEntry = {
  class: string;
  writerSymbol: string;
  /** Every CLI verb whose real writer can emit this artifact class. */
  verbs: NonEmptyReadonlyArray<CliVerb>;
  /** Every source module that writes this class; staleness covers their union. */
  writerModules: NonEmptyReadonlyArray<string>;
  guardDisposition: Exclude<GuardDisposition, 'deliberately-unguarded'>;
  /** Optional path-specific protection wording when one class has more than one guard. */
  protectionDetail?: string;
  evidenceMode: EvidenceMode;
  customerVisible: boolean;
  privacyDisposition?: PrivacyDisposition;
  reason?: never;
};

type DeliberatelyUnguardedArtifactRegistryEntry = {
  class: string;
  writerSymbol: string;
  /** Every CLI verb whose real writer can emit this artifact class. */
  verbs: NonEmptyReadonlyArray<CliVerb>;
  /** Every source module that writes this class; staleness covers their union. */
  writerModules: NonEmptyReadonlyArray<string>;
  guardDisposition: 'deliberately-unguarded';
  protectionDetail?: string;
  evidenceMode: EvidenceMode;
  customerVisible: boolean;
  privacyDisposition?: PrivacyDisposition;
  reason: string;
};

export type ArtifactRegistryEntry =
  | GuardedArtifactRegistryEntry
  | DeliberatelyUnguardedArtifactRegistryEntry;

const ARTIFACT_REGISTRY_BASE = [
  {
    class: 'init-config',
    writerSymbol: 'saveProviderConfig',
    verbs: ['init'],
    writerModules: ['src/providers/posthog-adapter.ts', 'src/cli/verbs/init.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: false,
  },
  {
    class: 'version-stdout',
    writerSymbol: 'runVersion',
    verbs: ['version'],
    writerModules: ['src/cli/verbs/version.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'explain-stdout-envelope',
    writerSymbol: 'runExplain',
    verbs: ['explain'],
    writerModules: ['src/cli/verbs/explain.ts', 'src/refusal-registry.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'sessions-stdout-envelope',
    writerSymbol: 'runSessions',
    verbs: ['sessions'],
    writerModules: ['src/cli/verbs/sessions.ts', 'src/cli/verbs/sessions-watch.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'completion-census',
    writerSymbol: 'writeCompletionCensus',
    verbs: ['sessions'],
    writerModules: ['src/completion-census.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'gaps-stdout-envelope',
    writerSymbol: 'runGaps',
    verbs: ['gaps'],
    writerModules: ['src/cli/verbs/gaps.ts', 'src/gap-map.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'scan-status-stdout-envelope',
    writerSymbol: 'runScanStatus',
    verbs: ['scan-status'],
    writerModules: ['src/cli/verbs/scan-status.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'sampled-register-cache',
    writerSymbol: 'writeSampledRegister',
    verbs: ['gaps'],
    writerModules: ['src/sampled-register.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'plan-json',
    writerSymbol: 'runPlan / runFixSelector',
    verbs: ['plan', 'triage', 'regenerate', 'heal', 'accept', 'fix-selector'],
    writerModules: ['src/cli/verbs/plan.ts', 'src/cli/verbs/triage.ts', 'src/cli/verbs/regenerate.ts', 'src/accept.ts', 'src/heal.ts', 'src/cli/verbs/fix-selector.ts'],
    guardDisposition: 'scripted-battery',
    protectionDetail: 'Frozen golden files verify `plan` output byte-for-byte; a scripted battery also exercises repair-path writers, including `fix-selector`.',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'plan-md',
    writerSymbol: 'runPlan / runFixSelector',
    verbs: ['plan', 'scaffold', 'triage', 'regenerate', 'heal', 'accept', 'fix-selector'],
    writerModules: ['src/cli/verbs/plan.ts', 'src/cli/verbs/triage.ts', 'src/cli/verbs/regenerate.ts', 'src/accept.ts', 'src/heal.ts', 'src/cli/verbs/scaffold.ts', 'src/cli/verbs/fix-selector.ts'],
    guardDisposition: 'scripted-battery',
    protectionDetail: 'Frozen golden files verify `plan` output byte-for-byte; a scripted battery also exercises repair-path writers, including `fix-selector`.',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'plan-diff-md',
    writerSymbol: 'runTriage',
    verbs: ['triage', 'regenerate', 'heal'],
    writerModules: ['src/cli/verbs/triage.ts', 'src/cli/verbs/regenerate.ts', 'src/heal.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'diff-stdout',
    writerSymbol: 'runDiff',
    verbs: ['diff'],
    writerModules: ['src/cli/verbs/diff.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'empty-marker',
    writerSymbol: 'emptyMarker',
    verbs: ['plan'],
    writerModules: ['src/cli/verbs/plan.ts'],
    guardDisposition: 'golden-frozen',
    evidenceMode: 'offline-coverable',
    customerVisible: false,
  },
  {
    class: 'scaffold-spec',
    writerSymbol: 'runScaffold',
    verbs: ['scaffold'],
    writerModules: ['src/cli/verbs/scaffold.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'auth-setup',
    writerSymbol: 'runAuthSetup',
    verbs: ['auth-setup'],
    writerModules: ['src/cli/verbs/auth-setup.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'spec-emitted-hashes',
    writerSymbol: 'stampEmittedSpecHash / markSpecHashAccepted',
    verbs: ['scaffold', 'fix-selector', 'accept', 'retire'],
    writerModules: ['src/spec-emitted-hashes.ts', 'src/cli/verbs/scaffold.ts', 'src/cli/verbs/fix-selector.ts', 'src/accept.ts', 'src/cli/verbs/retire-cleanup.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: false,
  },
  {
    class: 'repro-spec',
    writerSymbol: 'runRepro',
    verbs: ['repro'],
    writerModules: ['src/cli/verbs/repro.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'selector-patched-spec',
    writerSymbol: 'applyPersistedSelectorPatch',
    verbs: ['fix-selector'],
    writerModules: ['src/selector-apply.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'frames-html',
    writerSymbol: 'runFrames',
    verbs: ['frames'],
    writerModules: ['src/frames.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'frames-png',
    writerSymbol: 'runFrames',
    verbs: ['frames'],
    writerModules: ['src/frames.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'frames-manifest',
    writerSymbol: 'runFrames',
    verbs: ['frames'],
    writerModules: ['src/frames.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'frames-agent-brief',
    writerSymbol: 'runFrames',
    verbs: ['frames'],
    writerModules: ['src/frames.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'triage-selector-evidence',
    writerSymbol: 'persistTriageEvidence',
    // Retire may remove this cache during its archive transaction, but does
    // not publish its shape; the registry's writer inventory names producers.
    verbs: ['triage'],
    writerModules: ['src/triage-evidence.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: false,
  },
  {
    class: 'triage-report-cache',
    writerSymbol: 'runTriage',
    // Retire may remove this cache during its archive transaction, but does
    // not publish its shape; the registry's writer inventory names producers.
    verbs: ['triage'],
    writerModules: ['src/cli/verbs/triage.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: false,
  },
  {
    class: 'heal-latest-state',
    writerSymbol: 'persistHealState / writeLifecycleEvidence',
    verbs: ['heal', 'retire', 'suite-health'],
    writerModules: ['src/cli/verbs/heal.ts', 'src/cli/verbs/retire-cleanup.ts', 'src/suite-health.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: false,
  },
  {
    class: 'heal-last-run-state',
    writerSymbol: 'persistHealState',
    verbs: ['heal'],
    writerModules: ['src/cli/verbs/heal.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: false,
  },
  {
    class: 'selector-apply-record',
    writerSymbol: 'applyPersistedSelectorPatch',
    verbs: ['fix-selector', 'retire'],
    writerModules: ['src/selector-apply.ts', 'src/cli/verbs/retire-cleanup.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: false,
  },
  {
    class: 'doctor-stdout-envelope',
    writerSymbol: 'runDoctor',
    verbs: ['doctor'],
    writerModules: ['src/cli/verbs/doctor.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'preflight-stdout-envelope',
    writerSymbol: 'runPreflight',
    verbs: ['preflight'],
    writerModules: ['src/cli/verbs/preflight.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'suite-status-stdout-envelope',
    writerSymbol: 'runSuiteStatus',
    verbs: ['suite-status'],
    writerModules: ['src/cli/verbs/suite-status.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'suite-health-stdout-envelope',
    writerSymbol: 'runSuiteHealth',
    verbs: ['suite-health'],
    writerModules: ['src/cli/verbs/suite-health.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: true,
  },
  {
    class: 'reconcile-stdout-envelope',
    writerSymbol: 'runReconcile',
    verbs: ['reconcile'],
    writerModules: ['src/cli/verbs/reconcile.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'fix-selector-stdout-envelope',
    writerSymbol: 'runFixSelector',
    verbs: ['fix-selector'],
    writerModules: ['src/cli/verbs/fix-selector.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'retirement-json',
    writerSymbol: 'runRetire',
    verbs: ['retire'],
    writerModules: ['src/cli/verbs/retire.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: false,
  },
  {
    class: 'retired-folder',
    writerSymbol: 'runRetire',
    verbs: ['retire'],
    writerModules: ['src/cli/verbs/retire.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'offline-coverable',
    customerVisible: true,
  },
  {
    class: 'coarse-store',
    writerSymbol: 'atomicWrite',
    verbs: ['sessions', 'triage', 'plan', 'dashboard'],
    writerModules: ['src/coarse-store.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: false,
  },
  {
    class: 'dashboard-local-cache',
    writerSymbol: 'DashboardLocalStore.writeJson',
    verbs: ['dashboard', 'sessions', 'suite-health'],
    writerModules: ['src/dashboard/local-store.ts'],
    guardDisposition: 'unit-only',
    evidenceMode: 'live-gated',
    customerVisible: false,
  },
  {
    class: 'dashboard-http-payload',
    writerSymbol: 'sendJson',
    verbs: ['dashboard'],
    writerModules: ['src/dashboard/server.ts'],
    guardDisposition: 'deliberately-unguarded',
    evidenceMode: 'socket',
    customerVisible: true,
    reason: 'The dashboard response is a live socket surface; it is registered for map coverage but intentionally outside the filesystem emit chokepoint.',
  },
] as const satisfies readonly ArtifactRegistryEntry[];

const ARTIFACT_PRIVACY_DISPOSITION_BY_CLASS: Record<string, PrivacyDisposition> = {
  'init-config': 'declared-sensitive',
  'version-stdout': 'disclose',
  'explain-stdout-envelope': 'disclose',
  'sessions-stdout-envelope': 'disclose',
  'completion-census': 'seam-only',
  'gaps-stdout-envelope': 'disclose',
  'scan-status-stdout-envelope': 'disclose',
  'sampled-register-cache': 'seam-only',
  'plan-json': 'disclose',
  'plan-md': 'disclose',
  'plan-diff-md': 'disclose',
  'diff-stdout': 'disclose',
  'empty-marker': 'seam-only',
  'scaffold-spec': 'disclose',
  'auth-setup': 'block-override',
  'spec-emitted-hashes': 'seam-only',
  'repro-spec': 'disclose',
  'selector-patched-spec': 'block-override',
  'frames-html': 'declared-sensitive',
  'frames-png': 'declared-sensitive',
  'frames-manifest': 'declared-sensitive',
  'frames-agent-brief': 'declared-sensitive',
  'triage-selector-evidence': 'seam-only',
  'triage-report-cache': 'seam-only',
  'heal-latest-state': 'seam-only',
  'heal-last-run-state': 'seam-only',
  'selector-apply-record': 'seam-only',
  'doctor-stdout-envelope': 'disclose',
  'preflight-stdout-envelope': 'disclose',
  'suite-status-stdout-envelope': 'disclose',
  'suite-health-stdout-envelope': 'disclose',
  'reconcile-stdout-envelope': 'disclose',
  'fix-selector-stdout-envelope': 'disclose',
  'retirement-json': 'block-override',
  'retired-folder': 'rename-seam',
  'coarse-store': 'seam-only',
  'dashboard-local-cache': 'seam-only',
  'dashboard-http-payload': 'disclose',
};

/** Every registry row carries the disposition consumed by the write seam. */
export const ARTIFACT_REGISTRY = ARTIFACT_REGISTRY_BASE.map((entry) => ({
  ...entry,
  privacyDisposition: ARTIFACT_PRIVACY_DISPOSITION_BY_CLASS[entry.class],
})) as ReadonlyArray<(typeof ARTIFACT_REGISTRY_BASE)[number] & { readonly privacyDisposition: PrivacyDisposition }>;

export type ArtifactClass = (typeof ARTIFACT_REGISTRY)[number]['class'];

/**
 * Registry-aware assertion for write primitives that cannot use emitArtifact
 * because they own a different publication protocol (coarse cache, dashboard
 * cache, retire journal, or rename seam). Keeping this lookup here means a
 * primitive cannot silently invent or drift its privacy class.
 */
export function assertArtifactPrivacyDisposition(
  artifactClass: ArtifactClass,
  expected: PrivacyDisposition,
): void {
  const entry = ARTIFACT_REGISTRY.find((candidate) => candidate.class === artifactClass);
  if (entry?.privacyDisposition !== expected) {
    throw new Error(`Artifact registry privacy disposition mismatch for ${artifactClass}: expected ${expected}.`);
  }
}

/** The product verbs dispatched by `src/cli.ts`; a registry test guards this declaration against router drift. */
export type CliVerb =
  | 'init'
  | 'version'
  | 'sessions'
  | 'gaps'
  | 'scan-status'
  | 'plan'
  | 'scaffold'
  | 'frames'
  | 'repro'
  | 'preflight'
  | 'triage'
  | 'regenerate'
  | 'diff'
  | 'doctor'
  | 'heal'
  | 'accept'
  | 'retire'
  | 'suite-status'
  | 'suite-health'
  | 'reconcile'
  | 'fix-selector'
  | 'auth-setup'
  | 'dashboard'
  | 'explain';

/**
 * Runtime companion to the hand-declared `CliVerb` union.
 *
 * The artifact-registry unit tests compare this independent list with
 * the command-router AST so a router change cannot silently under-derive the
 * coverage map.
 */
export const CLI_VERBS = [
  'init',
  'version',
  'sessions',
  'gaps',
  'scan-status',
  'plan',
  'scaffold',
  'frames',
  'repro',
  'preflight',
  'triage',
  'regenerate',
  'diff',
  'doctor',
  'heal',
  'accept',
  'retire',
  'suite-status',
  'suite-health',
  'reconcile',
  'fix-selector',
  'auth-setup',
  'dashboard',
  'explain',
] as const satisfies readonly CliVerb[];

/** A coverage-map row key: one CLI surface crossed with one product artifact class. */
export interface Surface {
  verb: CliVerb;
  artifactClass: ArtifactClass;
}

/**
 * The typed filesystem emission boundary for product artifacts.
 *
 * `artifactClass` is intentionally consumed only for its type: selecting an
 * unregistered class is a compile error, while the underlying write remains
 * exactly Node's existing synchronous byte write.
 */
export function emitArtifact(
  artifactClass: ArtifactClass,
  targetPath: string,
  content: string | NodeJS.ArrayBufferView,
  options: ArtifactPrivacyOptions = {},
): void {
  const registryEntry = ARTIFACT_REGISTRY.find((entry) => entry.class === artifactClass);
  if (registryEntry?.privacyDisposition === 'block-override' && options.privacyDisclosure !== undefined && options.allowPrivacyDisclosure !== true) {
    throw new Error(PRIVACY_DISCLOSURE_REQUIRED_COPY);
  }
  const resolved = path.resolve(targetPath);
  const parts = resolved.split(path.sep);
  const stateIndex = parts.findIndex((part, index) => part === '.replaytest' && parts[index + 1] === 'state');
  if (stateIndex !== -1) {
    throw new Error(`state-artifact write refused at ${resolved}; bind the write to the shared state-lock facade.`);
  }
  if (typeof content === 'string') {
    fs.writeFileSync(targetPath, content, 'utf8');
    return;
  }
  fs.writeFileSync(targetPath, content);
}
