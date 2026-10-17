/**
 * `suite-status` — the dead-coverage reverse pass. Dead coverage is a
 * separate surface, not a sixth `TriageVerdict`: a `TriageVerdict` classifies
 * a failing test, while dead coverage exists on a green one. It walks every sidecar plan under
 * `.replaytest/plans/*.plan.json` (never the failing-spec direction `heal`
 * walks) and asks, per plan: is this journey's signature still present in
 * recent traffic at all?
 *
 * Honesty rules this module enforces (binding):
 *   - amendment 1's memoization pattern is REUSED here (`heal.ts`'s
 *     `createMemoizedCoarseSessionsFetcher`) — ONE coarse scan for the whole
 *     reverse pass, never one per plan.
 *   - A sidecar with no `source.signature` (a pre-signature plan) is
 *     reported `unresolvable`, NEVER counted as dead — no legacy refetch in
 *     v1 (an honest note instead of silently guessing).
 *   - "0 candidates" is framed as "no traffic in the last N h window", with
 *     a MANDATORY seasonality caveat — never "delete this test". Dead
 *     coverage is a prompt to look, not a verdict to act on blindly.
 *   - content-hash plan/spec state and missing-spec (planned but never
 *     scaffolded) are surfaced as info rows, not folded into the
 *     dead/covered/unresolvable verdict.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { appScopeDisclosure, scopeSessionsByWitnessedUrls, type AppScope, type AppScopeDisclosure } from './app-scope.js';
import { canonicalizePath, extractPathname, type WizardStepParamNames } from './canonical-url.js';
import { signatureSemanticsReview, type SignatureSemanticsReview } from './sidecar.js';
import { fetchCoarseSessions, resolveSessionScanHours } from './providers/posthog-adapter.js';
import { findSignatureCandidates } from './selection.js';
import { parseSidecarJson, type TriageFetchers } from './triage.js';
import { createMemoizedCoarseSessionsFetcher } from './heal.js';
import { collectGeneratedSpecHeaders, type SuiteStatusGeneratedSpecScan } from './generated-spec-headers.js';
import { planDriftClaim, readSpecEmittedHashes, resolvePlanDrift, specEmittedHashesPath, withRelocatedSpec, type PlanDriftState } from './spec-emitted-hashes.js';
import { buildReplanCommand } from './plan-review-report.js';
import { collectOrphanPlansReport, type SupersededPlan } from './orphan-plans.js';
import type { SpecLifecycleResult } from './spec-status.js';

export type SuiteStatusVerdict = 'covered' | 'dead' | 'unresolvable';

/**
 * Present only on a `dead` row whose exact signature was absent, but whose
 * route is contained in longer coarse (session-level) routes.  The coarse
 * scan cannot establish that the embedded route was the same journey, so this
 * is an explicit limitation marker rather than a second verdict.
 */
export interface DeadCoverageQualifier {
  kind: 'coarse-subjourney';
  longerRoutesFound: number;
}

export interface SuiteStatusEntry {
  slug: string;
  verdict: SuiteStatusVerdict;
  candidatesFound?: number;
  /** Additive; omitted unless a dead result has the coarse sub-journey ambiguity. */
  deadCoverageQualifier?: DeadCoverageQualifier;
  hasSpec: boolean;
  /** Always present: content-hash drift is `unknown` when it cannot be established. */
  drift: PlanDriftState;
  /** Detection-only migration marker; never changes the coverage verdict itself. */
  signatureSemanticsNeedsReview?: SignatureSemanticsReview;
  /** Present exactly with the migration marker; regenerates this plan's key. */
  signatureSemanticsReplanCommand?: string;
  note: string;
  /** Additive lifecycle projection; absent on callers that predate lifecycle projection. */
  lifecycle?: SpecLifecycleResult['lifecycle'];
  evidenceBasis?: string;
  reason?: string;
  recordedAt?: string;
  stale?: true;
}

export interface SuiteStatusReport {
  kind: 'suite-status-report';
  window: { sinceHours: number };
  coarseScanFetchCount: number;
  entries: SuiteStatusEntry[];
  /** Historical sidecars, separate from ordinary suite verdicts. */
  supersededPlans: SupersededPlan[];
  /**
   * Which app boundary the coverage evidence was counted inside, plus the
   * sessions that boundary set aside. Absent on a single-property unscoped
   * pass, so that report is unchanged.
   */
  appScope?: AppScopeDisclosure;
  /** Internal scan provenance; the stable JSON envelope emits its derived partiality projection. */
  generatedSpecScan?: SuiteStatusGeneratedSpecScan;
}

export interface SuiteStatusCollectOptions {
  plansDir: string;
  generatedTestsDir: string;
  workspaceRoot?: string;
  sinceHours?: number;
  wizardStepParamNames?: WizardStepParamNames;
  /**
   * The declared app boundary this reverse pass is confined to. Absent = the
   * whole project. Applied to the one shared scan before any plan is checked,
   * so a "dead" verdict can never be produced by counting another site's
   * traffic — or by failing to count this site's.
   */
  appScope?: AppScope;
  fetchers?: Partial<Pick<TriageFetchers, 'fetchCoarseSessions'>>;
  /** Test seam for the one record read shared by the whole reverse pass. */
  readDriftRecord?: typeof readSpecEmittedHashes;
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>;
  /** Loaded once by the command boundary and threaded through every slug. */
  handFinishedSlugs?: ReadonlySet<string>;
  /** Read-phase progress for the bounded generated-spec header inventory. */
  progress?: (line: string) => void;
}

const SEASONALITY_CAVEAT =
  'This does NOT mean delete this test — traffic can be seasonal (e.g. monthly billing runs, holiday ' +
  'promotions, a feature behind a flag) — widen --since-hours or check back later before retiring it.';

export function buildDeadNote(sinceHours: number): string {
  return `No traffic matching this plan's signature was found in the last ${sinceHours}h window. ${SEASONALITY_CAVEAT}`;
}

export function buildAmbiguousDeadNote(sinceHours: number, longerRoutesFound: number): string {
  const noun = longerRoutesFound === 1 ? 'route' : 'routes';
  return (
    `No exact match in live traffic was found in the last ${sinceHours}h window — but this journey appears inside ` +
    `${longerRoutesFound} longer recorded ${noun}, so it may still be occurring (approximate-scan limitation). ${SEASONALITY_CAVEAT}`
  );
}

export function buildCoveredNote(candidatesFound: number, sinceHours: number): string {
  const noun = candidatesFound === 1 ? 'session' : 'sessions';
  return `${candidatesFound} candidate ${noun} matching this plan's signature found in the last ${sinceHours}h window.`;
}

export function buildUnresolvableNote(reason: string): string {
  return `${reason} Not counted as dead — no legacy refetch happens automatically in this version.`;
}

function listPlanJsonFiles(plansDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(plansDir);
  } catch {
    return [];
  }
  // Proposals are drafts and `.superseded` files are quarantined history —
  // neither belongs in the live reverse pass.
  return entries
    .filter(
      (name) =>
        name.endsWith('.plan.json') &&
        !name.endsWith('.proposed.plan.json') &&
        !name.endsWith('.superseded.plan.json'),
    )
    .map((name) => path.join(plansDir, name))
    .sort();
}

function slugFromPlanPath(filePath: string): string {
  return path.basename(filePath).replace(/\.plan\.json$/, '');
}

function specPathFor(generatedTestsDir: string, slug: string): string {
  return path.join(generatedTestsDir, `${slug}.spec.ts`);
}

function readFileMaybe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function toDisplayPath(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function signatureSegments(signature: string): string[] {
  return signature.split(' > ');
}

function canonicalCoarseNavPath(session: { navPath: string[] }, paramNames?: WizardStepParamNames): string[] {
  return session.navPath.map((url) => canonicalizePath(extractPathname(url, 'preserve-raw', paramNames)));
}

function sameSignature(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * The dead-coverage reverse pass: one coarse scan (memoized — reused from
 * `heal.ts` rather than a second implementation), then per plan file,
 * `findSignatureCandidates` against that ONE shared scan. Impure (fs reads +
 * one network fetch) — mirrors `heal.ts`'s `collectHealReport` split (a
 * pure-computation core wrapped in a small impure orchestrator), not
 * `triage.ts`'s zero-fs purity, since walking N plan files IS this module's
 * job.
 */
export async function collectSuiteStatusReport(opts: SuiteStatusCollectOptions): Promise<SuiteStatusReport> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const sinceHours = resolveSessionScanHours(opts.sinceHours);
  const fetchCoarse = opts.fetchers?.fetchCoarseSessions ?? fetchCoarseSessions;
  const memoized = createMemoizedCoarseSessionsFetcher(fetchCoarse);

  const orphanReport = collectOrphanPlansReport(opts.plansDir);
  const supersededSlugs = new Set(orphanReport.plans.map((plan) => plan.slug));
  // An orphan has its own report bucket below. Do not duplicate
  // it in coverage/needs-review rows or allow it to inflate those counts.
  const planFiles = listPlanJsonFiles(opts.plansDir).filter(
    (planFile) => !supersededSlugs.has(slugFromPlanPath(planFile)),
  );
  const entries: SuiteStatusEntry[] = [];
  const recordPath = specEmittedHashesPath(workspaceRoot);
  const driftRecord = (opts.readDriftRecord ?? readSpecEmittedHashes)(recordPath);
  const generatedSpecScan = collectGeneratedSpecHeaders(opts.generatedTestsDir, workspaceRoot, opts.progress);

  // Never scan when there's nothing to check against — an empty plans/
  // directory shouldn't cost a network call.
  const rawCoarseSessions = planFiles.length === 0 ? [] : memoized.fetch({ sinceHours }).sessions;
  // The raw-array chokepoint, applied ONCE to the shared scan: every plan below
  // is then checked against the same in-scope corpus, so the coverage
  // denominator and each verdict describe one property.
  const scoped = scopeSessionsByWitnessedUrls(rawCoarseSessions, (session) => session.navPath, opts.appScope);

  for (const planFile of planFiles) {
    const slug = slugFromPlanPath(planFile);
    const specFile = specPathFor(opts.generatedTestsDir, slug);
    const hasSpec = fs.existsSync(specFile);
    const resolvedDrift = resolvePlanDrift({
      slug,
      plansDir: opts.plansDir,
      generatedTestsDir: opts.generatedTestsDir,
      workspaceRoot,
      recordPath,
      record: driftRecord,
      recordLoaded: true,
      handFinishedSlugs: opts.handFinishedSlugs,
    });
    const relocatedSpecPath = !hasSpec ? generatedSpecScan.headers.get(slug) : undefined;
    const drift = relocatedSpecPath === undefined ? resolvedDrift : withRelocatedSpec(resolvedDrift, relocatedSpecPath);

    const raw = readFileMaybe(planFile);
    if (raw === undefined) {
      entries.push({
        slug,
        verdict: 'unresolvable',
        hasSpec,
        drift,
        note: buildUnresolvableNote(`Could not read ${toDisplayPath(planFile, workspaceRoot)}.`),
      });
      continue;
    }

    const parsed = parseSidecarJson(raw);
    if (parsed.kind === 'invalid') {
      entries.push({
        slug,
        verdict: 'unresolvable',
        hasSpec,
        drift,
        note: buildUnresolvableNote(`Invalid plan JSON (${parsed.reason}).`),
      });
      continue;
    }

    const signatureReview = signatureSemanticsReview(
      parsed.sidecar.source,
      opts.wizardStepParamNames ?? ['step'],
    );
    const signatureSemanticsReplanCommand = signatureReview === undefined
      ? undefined
      : buildReplanCommand(parsed.sidecar.source.distinctId, parsed.sidecar.source.sessionId);
    const signature = parsed.sidecar.source.signature;
    if (signature === undefined || signature.trim().length === 0) {
      entries.push({
        slug,
        verdict: 'unresolvable',
        hasSpec,
        drift,
        ...(signatureReview === undefined ? {} : { signatureSemanticsNeedsReview: signatureReview }),
        ...(signatureSemanticsReplanCommand === undefined ? {} : { signatureSemanticsReplanCommand }),
        note: buildUnresolvableNote(
          'This plan predates recorded signatures (an older sidecar) — dead-coverage cannot be checked without one. Re-run "replaytest plan" for this journey to add one.',
        ),
      });
      continue;
    }

    // `findSignatureCandidates` is deliberately containment-based: it gives
    // us the existing canonical coarse evidence, including a plan embedded in
    // a longer session route.  Only a whole coarse route equal to the plan
    // signature counts as an exact match here; an embedded route is surfaced
    // as the qualifier below, never silently equated with one exact
    // journey confirmation.
    const coarseCandidates = findSignatureCandidates(scoped.sessions, signature, {
      excludeSessionId: parsed.sidecar.source.sessionId,
      paramNames: opts.wizardStepParamNames,
    });
    const target = signatureSegments(signature);
    // SCOPE ENFORCEMENT POINT (second of two). Both reads of the in-scope
    // array are load-bearing together and neither alone is observable: a
    // candidate absent from this map is dropped by `exactCandidates` and by
    // `longerRoutesFound` alike. If either read is ever re-pointed at the raw
    // scan, the other still filters the foreign session out — so re-point
    // NEITHER. See the foreign-longer-route test in suite-status.test.ts,
    // which names this relationship.
    const coarseBySessionId = new Map(scoped.sessions.map((session) => [session.sessionId, session]));
    const exactCandidates = coarseCandidates.filter((candidate) => {
      const session = coarseBySessionId.get(candidate.sessionId);
      return session !== undefined && sameSignature(canonicalCoarseNavPath(session, opts.wizardStepParamNames), target);
    });
    const longerRoutesFound = coarseCandidates.filter((candidate) => {
      const session = coarseBySessionId.get(candidate.sessionId);
      return session !== undefined && canonicalCoarseNavPath(session, opts.wizardStepParamNames).length > target.length;
    }).length;

    if (exactCandidates.length === 0) {
      const deadCoverageQualifier =
        longerRoutesFound > 0
          ? { kind: 'coarse-subjourney' as const, longerRoutesFound }
          : undefined;
      entries.push({
        slug,
        verdict: 'dead',
        candidatesFound: 0,
        ...(deadCoverageQualifier === undefined ? {} : { deadCoverageQualifier }),
        hasSpec,
        drift,
        ...(signatureReview === undefined ? {} : { signatureSemanticsNeedsReview: signatureReview }),
        ...(signatureSemanticsReplanCommand === undefined ? {} : { signatureSemanticsReplanCommand }),
        note:
          deadCoverageQualifier === undefined
            ? buildDeadNote(sinceHours)
            : buildAmbiguousDeadNote(sinceHours, deadCoverageQualifier.longerRoutesFound),
      });
    } else {
      entries.push({
        slug,
        verdict: 'covered',
        candidatesFound: exactCandidates.length,
        hasSpec,
        drift,
        ...(signatureReview === undefined ? {} : { signatureSemanticsNeedsReview: signatureReview }),
        ...(signatureSemanticsReplanCommand === undefined ? {} : { signatureSemanticsReplanCommand }),
        note: buildCoveredNote(exactCandidates.length, sinceHours),
      });
    }
  }

  // Retain the async API boundary while this report assembles synchronously.
  await Promise.resolve();
  const appScope = appScopeDisclosure(scoped, opts.appScope);
  return {
    kind: 'suite-status-report',
    window: { sinceHours },
    coarseScanFetchCount: memoized.callCount(),
    entries: entries.map((entry) => {
      const lifecycle = opts.lifecycleBySlug?.get(entry.slug);
      return lifecycle === undefined
        ? entry
        : {
          ...entry,
          ...(lifecycle.lifecycle === undefined ? {} : { lifecycle: lifecycle.lifecycle }),
          evidenceBasis: lifecycle.evidenceBasis,
          ...(lifecycle.reason === undefined ? {} : { reason: lifecycle.reason }),
          ...(lifecycle.recordedAt === undefined ? {} : { recordedAt: lifecycle.recordedAt }),
          ...(lifecycle.stale === undefined ? {} : { stale: lifecycle.stale }),
        };
    }),
    supersededPlans: orphanReport.plans,
    ...(appScope === undefined ? {} : { appScope }),
    generatedSpecScan: {
      capped: generatedSpecScan.capped,
      ...(generatedSpecScan.cappedBy === undefined ? {} : { cappedBy: generatedSpecScan.cappedBy }),
      skippedStandardDirs: generatedSpecScan.skippedStandardDirs,
      unreadableFiles: generatedSpecScan.unreadableFiles,
      duplicateSlugs: generatedSpecScan.duplicateSlugs,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering — human text + the stable `--json` envelope.
// ---------------------------------------------------------------------------

/** Human partial-scan disclosures follow the ten-item display convention in `src/cli/verbs/sessions.ts`. */
const UNASSESSED_SLUG_DISPLAY_CAP = 10;

export function formatUnassessedSlugDisclosure(slugs: readonly string[]): string {
  const sorted = [...slugs].sort();
  const shown = sorted.slice(0, UNASSESSED_SLUG_DISPLAY_CAP);
  const remaining = sorted.length - shown.length;
  if (remaining === 0) return shown.join(', ');
  return `${shown.join(', ')}, … and ${remaining} more (see --json generatedSpecScan.unassessedSlugs)`;
}

export function renderSuiteStatusReport(report: SuiteStatusReport): string {
  const lines: string[] = [
    `Window: last ${report.window.sinceHours}h`,
    `Coarse scan: ${report.coarseScanFetchCount} fetch(es) for ${report.entries.length} plan(s) checked (shared/memoized — never more than 1).`,
  ];

  if (report.entries.length === 0) {
    lines.push('', 'No plans found under .replaytest/plans/ — nothing to check.');
    return lines.join('\n');
  }

  const dead = report.entries.filter((e) => e.verdict === 'dead');
  const covered = report.entries.filter((e) => e.verdict === 'covered');
  const unresolvable = report.entries.filter((e) => e.verdict === 'unresolvable');

  if (dead.length > 0) {
    lines.push('', `Dead coverage — no traffic seen (${dead.length}):`);
    for (const entry of dead) lines.push(...renderEntry(entry));
  }

  if (unresolvable.length > 0) {
    lines.push('', `Unresolvable — cannot check (never counted as dead) (${unresolvable.length}):`);
    for (const entry of unresolvable) lines.push(...renderEntry(entry));
  }

  if (covered.length > 0) {
    lines.push('', `Covered — traffic present (${covered.length}):`);
    for (const entry of covered) lines.push(...renderEntry(entry));
  }

  if (report.supersededPlans.length > 0) {
    lines.push('', `Superseded plans (${report.supersededPlans.length}):`);
    for (const plan of report.supersededPlans) {
      lines.push(
        `- ${plan.slug} → ${plan.supersededBy.join(', ')} (generated ${plan.generatedAt}; current batch ${plan.supersededByGeneratedAt})`,
      );
      lines.push(`  ${plan.reconcileCommand}`);
    }
  }

  const needsReview = report.entries.filter((entry) => entry.signatureSemanticsNeedsReview !== undefined);
  if (needsReview.length > 0) {
    lines.push('', `Needs review — URL signature semantics (${needsReview.length}):`);
    for (const entry of needsReview) {
      lines.push(`- ${entry.slug}: ${entry.signatureSemanticsNeedsReview?.note}`);
      if (entry.signatureSemanticsReplanCommand !== undefined) lines.push(`  ${entry.signatureSemanticsReplanCommand}`);
    }
  }

  const missingSpec = report.entries.filter((e) => !e.hasSpec && e.drift.relocatedSpec === undefined);
  const generatedSpecScan = report.generatedSpecScan;
  const scanIsPartial = generatedSpecScan !== undefined && generatedSpecScanIsPartial(generatedSpecScan);
  const unassessedMissingSpec = scanIsPartial ? missingSpec : [];
  if (generatedSpecScan !== undefined && unassessedMissingSpec.length > 0) {
    const reasons: string[] = [];
    if (generatedSpecScan.capped) reasons.push(`capped by ${generatedSpecScan.cappedBy ?? 'a scan limit'}`);
    if (generatedSpecScan.unreadableFiles > 0) {
      reasons.push(`${generatedSpecScan.unreadableFiles} unreadable or oversized spec file${generatedSpecScan.unreadableFiles === 1 ? '' : 's'}`);
    }
    if (generatedSpecScan.skippedStandardDirs) reasons.push('standard directories were skipped');
    if (generatedSpecScan.duplicateSlugs.length > 0) {
      reasons.push(`duplicate slug headers for ${generatedSpecScan.duplicateSlugs.join(', ')}`);
    }
    lines.push(
      '',
      `Generated-spec header scan was partial (${reasons.join('; ')}). Relocation status was not assessed for: ${formatUnassessedSlugDisclosure(unassessedMissingSpec.map((entry) => entry.slug))}. No scaffold advice is shown for unassessed slugs.`,
    );
  }

  const scaffoldableMissingSpec = scanIsPartial ? [] : missingSpec;
  if (scaffoldableMissingSpec.length > 0) {
    lines.push('', `Planned but not scaffolded (${scaffoldableMissingSpec.length}):`);
    for (const entry of scaffoldableMissingSpec) {
      lines.push(`- ${entry.slug}: run "replaytest scaffold ${entry.slug}" to generate tests/generated/${entry.slug}.spec.ts.`);
    }
  }

  return lines.join('\n');
}

/**
 * Which drift claims this surface prints. The spec-absence/readability guards
 * are ADDED to the original verdict guard, not swapped for it: an
 * `unresolvable` row already carries its own instruction, and a second
 * competing one is the exact two-orders defect this copy pass exists to
 * remove. That verdict guard holds on EVERY drift verdict, not only the ones
 * the spec/readability guards also cover: an `unresolvable` row's own remedy
 * competes with a drift remedy whatever the drift axis concluded, so the
 * verdict clause is repeated on each branch rather than hoisted — each branch
 * states the whole condition it renders under, and each can be proven to fail
 * on its own. The wording of each claim lives in one shared place
 * (`planDriftClaim`) so heal, suite-status and preflight cannot drift apart.
 */
function suiteStatusRendersDriftClaim(entry: SuiteStatusEntry): boolean {
  if (entry.drift.relocatedSpec !== undefined) return entry.verdict !== 'unresolvable';
  const hasDeclaredStaleSpec = entry.drift.handFinishedDeclared === true || entry.drift.handFinishedStale === true;
  switch (entry.drift.verdict) {
    case 'drifted':
    case 'accepted-unverified':
      return entry.verdict !== 'unresolvable' && (entry.hasSpec || entry.drift.handFinishedStale === true);
    case 'unverified':
      return entry.verdict !== 'unresolvable' && (entry.hasSpec || entry.drift.handFinishedStale === true) && entry.drift.planIsReadable;
    case 'unknown':
      return entry.verdict !== 'unresolvable' && (entry.hasSpec || entry.drift.handFinishedStale === true) && entry.drift.planIsReadable;
    case 'current':
      return entry.verdict !== 'unresolvable' && hasDeclaredStaleSpec;
    default:
      return false;
  }
}

function renderEntry(entry: SuiteStatusEntry): string[] {
  const lines = [`- ${entry.slug}: ${entry.note}`];
  const driftClaim = planDriftClaim(entry.drift, entry.slug);
  if (driftClaim !== undefined && suiteStatusRendersDriftClaim(entry)) lines.push(`    ${driftClaim}`);
  return lines;
}

function generatedSpecScanIsPartial(scan: SuiteStatusGeneratedSpecScan): boolean {
  return scan.capped || scan.unreadableFiles > 0 || scan.skippedStandardDirs || scan.duplicateSlugs.length > 0;
}

function unassessedGeneratedSpecSlugs(report: SuiteStatusReport): string[] {
  const scan = report.generatedSpecScan;
  if (scan === undefined || !generatedSpecScanIsPartial(scan)) return [];
  return report.entries
    .filter((entry) => !entry.hasSpec && entry.drift.relocatedSpec === undefined)
    .map((entry) => entry.slug)
    .sort();
}

export function suiteStatusJsonEnvelope(report: SuiteStatusReport): object {
  const generatedSpecScan = report.generatedSpecScan;
  return {
    window: report.window,
    coarseScanFetchCount: report.coarseScanFetchCount,
    entries: report.entries,
    supersededPlans: report.supersededPlans,
    // Absent on an unscoped single-property pass, so the default envelope's
    // bytes are unchanged.
    appScope: report.appScope,
    ...(generatedSpecScan === undefined ? {} : {
      generatedSpecScan: {
        partial: generatedSpecScanIsPartial(generatedSpecScan),
        ...(generatedSpecScan.cappedBy === undefined ? {} : { cappedBy: generatedSpecScan.cappedBy }),
        unassessedSlugs: unassessedGeneratedSpecSlugs(report),
      },
    }),
  };
}

export function formatSuiteStatusJson(report: SuiteStatusReport): string {
  return `${JSON.stringify(suiteStatusJsonEnvelope(report), null, 2)}\n`;
}
