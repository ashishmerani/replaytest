import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  diffSidecars,
  formatDiffJson,
  formatDiffRefusalJson,
  renderSidecarDiff,
  renderTriageRefusal,
  type SidecarDiff,
  type TriageRefusal,
} from '../../triage.js';
import { trailMentionSentence } from '../../retirement-evidence.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, emitUsageError, parseDiffArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { PLANS_DIR, RETIRED_DIR } from '../paths.js';
import { appendRetiredAwareness } from '../retired-awareness.js';
import { displayPath, readSidecarForTriage } from '../sidecar-io.js';

export interface DiffRunDeps {
  plansDir?: string;
  retiredDir?: string;
  log?: (line: string) => void;
}

/**
 * Re-renders an existing proposal against the live sidecar without writing
 * either artifact. `--json` emits the same `SidecarDiff` object the
 * `triage --propose` / `heal --propose` / `regenerate` envelopes already
 * carry — this is the ONE diff-reading command the agent skill names, so it
 * is the one that most needed a structured surface (agent-first). Both
 * channels also carry `freshEvidenceGapNote`'s disclosure of the one thing
 * this command structurally cannot show.
 */
export function runDiff(argv: string[], deps: DiffRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'diff', deps.log)) return;
  const args = parseDiffArgs(argv);
  const slug = args.slug;
  const log = deps.log ?? ((line: string) => console.log(line));
  const refuse = (refusal: TriageRefusal): void => {
    log(args.json ? formatDiffRefusalJson(refusal).trimEnd() : renderTriageRefusal(refusal));
    process.exitCode = refusal.exitCode;
  };
  if (slug === undefined) {
    emitUsageError(args.json, buildUsageError('diff'), log);
    process.exitCode = 1;
    return;
  }

  const plansDir = deps.plansDir ?? PLANS_DIR;
  const retiredDir = deps.retiredDir ?? RETIRED_DIR;
  const proposedPath = path.join(plansDir, `${slug}.proposed.plan.json`);
  const livePath = path.join(plansDir, `${slug}.plan.json`);
  if (!fs.existsSync(proposedPath)) {
    // Name the recorded state rather than looping the customer back with
    // no acknowledgement that fresh-traffic searches have been accumulating.
    // The live plan is read only for its trail; an unreadable one yields no
    // sentence, because this refusal is about the missing PROPOSAL.
    const live = readSidecarForTriage(slug, livePath, displayPath(livePath), retiredDir);
    const trailSentence = live.kind === 'sidecar' ? trailMentionSentence(live.sidecar) : undefined;
    refuse({
      kind: 'refusal',
      code: 'missing-sidecar',
      message: appendRetiredAwareness(
        slug,
        `No proposed sidecar found for "${slug}". ${trailSentence === undefined ? '' : `${trailSentence} `}Run \`${TOOL_NAME} triage ${slug} --propose\` or \`${TOOL_NAME} regenerate ${slug}\` to create one.`,
        retiredDir,
      ),
      exitCode: 1,
    });
    return;
  }

  if (!fs.existsSync(livePath)) {
    refuse({
      kind: 'refusal',
      code: 'missing-sidecar',
      message: appendRetiredAwareness(
        slug,
        // Comparing needs two things to compare, so this is a real limit rather
        // than a bug — worth saying out loud. For a first-time proposal there is
        // nothing to diff AGAINST, and accepting it is the genuine move: it
        // leaves the reader somewhere different (the plan is now live).
        `Cannot diff "${slug}": no live sidecar found at ${displayPath(livePath)}. ` +
        'diff compares a proposal against an existing live plan — if this is the proposal\'s first review ' +
        `(nothing accepted yet), skip diff and either read the proposal directly, or run \`${TOOL_NAME} accept ${slug}\` to promote it.`,
        retiredDir,
      ),
      exitCode: 1,
    });
    return;
  }

  const live = readSidecarForTriage(slug, livePath, displayPath(livePath), retiredDir);
  if (live.kind === 'refusal') {
    refuse(live);
    return;
  }
  const proposed = readSidecarForTriage(slug, proposedPath, displayPath(proposedPath));
  if (proposed.kind === 'refusal') {
    refuse(proposed);
    return;
  }
  const diff = diffSidecars(live.sidecar, proposed.sidecar);
  const note = freshEvidenceGapNote(diff, plansDir, slug);
  if (args.json) {
    log(formatDiffJson(slug, diff, note).trimEnd());
    return;
  }
  // Shared diff rendering: this is `renderSidecarDiff(diff)` verbatim,
  // byte-identical to the three persisted-file callers. The note below is a
  // separate trailing line, never part of the rendered diff.
  log(renderSidecarDiff(diff));
  // Blank-line separated so it reads as a footer, not as another bullet of
  // whichever section happened to render last.
  if (note !== undefined) log(`\n${note}`);
}

/**
 * Disclose the fresh-traffic evidence unavailable to this command. `diff` re-derives
 * from the two plan files and structurally holds no `SelectorFreshnessEvidence`,
 * so where `triage --propose` / `heal --propose` render a `selector freshness:`
 * recommendation under a changed locator, this command renders nothing — a
 * strictly smaller document than the `.proposed.diff.md` those runs persisted,
 * while the docs point agents here for "the same delta". Both renderings are
 * honest; the SILENCE about the difference was the defect, so the gap is
 * disclosed exactly where it can bite: on a diff that moved a locator.
 */
function freshEvidenceGapNote(diff: SidecarDiff, plansDir: string, slug: string): string | undefined {
  const locatorMoved = diff.steps.changed.some(
    (change) => change.quality !== undefined && change.quality.freshness === undefined,
  );
  if (!locatorMoved) return undefined;
  const persistedPath = path.join(plansDir, `${slug}.proposed.diff.md`);
  // Deliberately never promises the evidence is THERE: a triage/heal run only
  // renders a freshness line for steps its report actually matched. What is
  // true is that the persisted file is the rendering written by the run that
  // held the report, so it is the only place the evidence could be. EXCEPT for
  // a regenerate-backed proposal: regenerate writes the same persisted slot but
  // holds no traffic report, so pointing at its file would claim evidence that
  // does not exist anywhere, so the freshness line must not claim it.
  const where = diff.summary.regenerated
    ? `This proposal came from \`${TOOL_NAME} regenerate\`, which holds no traffic report — no fresh-traffic recommendation exists for it.`
    : fs.existsSync(persistedPath)
      ? `Read ${displayPath(persistedPath)} — the rendering written by the run that held one.`
      : `Re-run \`${TOOL_NAME} triage ${slug} --propose\` (or \`${TOOL_NAME} heal --propose\`) to produce that rendering.`;
  return (
    `Note: this diff is re-derived from the two plan files, so a changed locator shows the plan's own selector quality (where the plan records one and the confidence actually moved, the new locator is a guess, or it carries warnings) ` +
    `but no fresh-traffic recommendation — that evidence exists only on the \`${TOOL_NAME} triage --propose\` / ` +
    `\`${TOOL_NAME} heal --propose\` run that held a traffic report. ${where}`
  );
}
