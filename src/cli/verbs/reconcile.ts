import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectOrphanPlansReport, RECONCILE_COMMAND, type OrphanPlansReport, type SupersededPlan } from '../../orphan-plans.js';
import { maybePrintVerbHelp } from '../help.js';
import { parseReconcileArgs } from '../args.js';
import { GENERATED_TESTS_DIR, PLANS_DIR, RETIRED_DIR } from '../paths.js';
import { retirementRecoveryMessage } from '../retired-awareness.js';
import { formatLocalTimeWithUtc } from '../terminal-format.js';

/** `plan`'s non-destructive, session-scoped reconciliation nudge. */
export function formatPlanSupersededReport(plans: readonly SupersededPlan[]): string[] {
  return [
    '',
    `⚠ Superseded plans detected (${plans.length}) — no files were renamed:`,
    ...plans.flatMap((plan) => [
      `- ${plan.slug}: superseded by ${plan.supersededBy.join(', ')} ` +
        `(generated ${formatLocalTimeWithUtc(plan.generatedAt)}; current batch ${formatLocalTimeWithUtc(plan.supersededByGeneratedAt)})`,
      `  Run ${plan.reconcileCommand} to quarantine this sidecar by rename.`,
    ]),
  ];
}

// ---------------------------------------------------------------------------
// reconcile — explicit, rename-only orphan-plan quarantine.
// ---------------------------------------------------------------------------

export interface ReconcileRunDeps {
  plansDir?: string;
  generatedTestsDir?: string;
  retiredDir?: string;
  log?: (line: string) => void;
}

function resolveReconcileRunDeps(deps: ReconcileRunDeps): Required<ReconcileRunDeps> {
  return {
    plansDir: deps.plansDir ?? PLANS_DIR,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    retiredDir: deps.retiredDir ?? RETIRED_DIR,
    log: deps.log ?? ((line: string) => console.log(line)),
  };
}

function supersededPaths(plansDir: string, slug: string): {
  liveJson: string;
  supersededJson: string;
  liveMarkdown: string;
  supersededMarkdown: string;
} {
  return {
    liveJson: path.join(plansDir, `${slug}.plan.json`),
    supersededJson: path.join(plansDir, `${slug}.superseded.plan.json`),
    liveMarkdown: path.join(plansDir, `${slug}.md`),
    supersededMarkdown: path.join(plansDir, `${slug}.superseded.md`),
  };
}

/** The default `reconcile` report: evidence plus the exact acting command. */
export function formatReconcileReport(report: OrphanPlansReport): string {
  if (report.plans.length === 0) {
    return report.skipped.length === 0
      ? 'No superseded plans found — no files changed.'
      : `No superseded plans found — no files changed. Skipped ${report.skipped.length} unreadable/invalid sidecar(s).`;
  }

  return [
    `Superseded plans (${report.plans.length}) — report only; no files changed:`,
    ...report.plans.flatMap((plan) => [
      `- ${plan.slug}: superseded by ${plan.supersededBy.join(', ')} ` +
        `(generated ${formatLocalTimeWithUtc(plan.generatedAt)}; current batch ${formatLocalTimeWithUtc(plan.supersededByGeneratedAt)})`,
      `  Would rename .replaytest/plans/${plan.slug}.plan.json -> .replaytest/plans/${plan.slug}.superseded.plan.json`,
      `  Would rename .replaytest/plans/${plan.slug}.md -> .replaytest/plans/${plan.slug}.superseded.md`,
    ]),
    `Run ${RECONCILE_COMMAND} to apply these rename(s).`,
    ...(report.skipped.length === 0 ? [] : [`Skipped ${report.skipped.length} unreadable/invalid sidecar(s); none were changed.`]),
  ].join('\n');
}

function renameSupersededHalf(
  from: string,
  to: string,
  label: string,
  log: (line: string) => void,
  slug: string,
  retiredDir: string,
): boolean {
  const recovery = retirementRecoveryMessage(slug, retiredDir);
  if (recovery !== undefined) {
    log(`  ${label}: ${recovery}`);
    process.exitCode = 1;
    return false;
  }
  if (!fs.existsSync(from)) {
    log(`  ${label}: source half is missing; left it absent.`);
    return true;
  }
  // `renameSync` would replace an existing destination on this platform, so
  // protect user-owned prior quarantine history before calling it.
  if (fs.existsSync(to)) {
    log(`  ${label}: destination already exists; left the live half untouched to avoid overwriting it.`);
    return true;
  }
  try {
    fs.renameSync(from, to);
    log(`  ${label}: renamed.`);
    return true;
  } catch (err) {
    log(`  ${label}: could not rename (${err instanceof Error ? err.message : String(err)}); the other half was not rolled back.`);
    return false;
  }
}

/**
 * `replaytest reconcile` — report by default; `--apply` is the sole explicit
 * mutation path.  Each pair half is handled independently so a missing
 * Markdown projection never prevents quarantine of its source-of-truth JSON.
 */
export function runReconcile(argv: string[], deps: ReconcileRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'reconcile', deps.log)) return;
  const resolvedDeps = resolveReconcileRunDeps(deps);
  const args = parseReconcileArgs(argv);
  const report = collectOrphanPlansReport(resolvedDeps.plansDir);

  if (!args.apply) {
    resolvedDeps.log(formatReconcileReport(report));
    return;
  }
  if (report.plans.length === 0) {
    resolvedDeps.log(formatReconcileReport(report));
    return;
  }

  resolvedDeps.log(`Superseded plans (${report.plans.length}) — applying rename-only quarantine:`);
  for (const plan of report.plans) {
    const paths = supersededPaths(resolvedDeps.plansDir, plan.slug);
    resolvedDeps.log(
      `- ${plan.slug}: superseded by ${plan.supersededBy.join(', ')} ` +
        `(generated ${formatLocalTimeWithUtc(plan.generatedAt)}; current batch ${formatLocalTimeWithUtc(plan.supersededByGeneratedAt)})`,
    );
    if (!renameSupersededHalf(paths.liveJson, paths.supersededJson, '.plan.json', resolvedDeps.log, plan.slug, resolvedDeps.retiredDir)) continue;
    if (!renameSupersededHalf(paths.liveMarkdown, paths.supersededMarkdown, '.md', resolvedDeps.log, plan.slug, resolvedDeps.retiredDir)) continue;

    const specPath = path.join(resolvedDeps.generatedTestsDir, `${plan.slug}.spec.ts`);
    if (fs.existsSync(specPath)) {
      resolvedDeps.log(`  tests/generated/${plan.slug}.spec.ts exists and was left untouched (user-owned).`);
    }
  }
  if (report.skipped.length > 0) {
    resolvedDeps.log(`Skipped ${report.skipped.length} unreadable/invalid sidecar(s); none were changed.`);
  }
}
