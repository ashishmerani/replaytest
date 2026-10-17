// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import { fetchFullReplayStream, fetchNeutralSessionsWithDomEnrichment, type ReplayStreamWindow } from '../../providers/posthog-adapter.js';
import { createArchiveFetchers, fetchArchiveFullReplayStream } from '../../providers/archive-adapter.js';
import type { NeutralSession } from '../../neutral-session.js';
import { formatFramesRunResult, runFrames, type FramesRunDeps } from '../../frames.js';
import { renderCaptures } from '../../frames-render.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, parseFramesArgs } from '../args.js';
import { FRAMES_DIR, PLANS_DIR, WORKSPACE_ROOT } from '../paths.js';

// ---------------------------------------------------------------------------
// frames — argument wiring only. Capture selection, PII checking, manifest
// lineage, and all filesystem writes live in `frames.ts`; this CLI layer only
// chooses the already-neutral live/archive fetch seams.
// ---------------------------------------------------------------------------

export interface FramesCliRunDeps extends Partial<FramesRunDeps> {
  fetchArchiveNeutralSessions?: (archiveDir: string, sessionId: string) => Promise<NeutralSession[]>;
  fetchArchiveFullReplayStream?: (archiveDir: string, sessionId: string) => ReplayStreamWindow[];
  /** Progress stays on stderr; frame artifacts retain their normal stdout outcome. */
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

type FramesCliResolvedDeps = FramesRunDeps & {
  fetchArchiveNeutralSessions: (archiveDir: string, sessionId: string) => Promise<NeutralSession[]>;
  fetchArchiveFullReplayStream: (archiveDir: string, sessionId: string) => ReplayStreamWindow[];
  progress: (line: string) => void;
  log: (line: string) => void;
};

function resolveFramesRunDeps(deps: FramesCliRunDeps): FramesCliResolvedDeps {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  return {
    plansDir: deps.plansDir ?? PLANS_DIR,
    framesDir: deps.framesDir ?? FRAMES_DIR,
    workspaceRoot: deps.workspaceRoot ?? WORKSPACE_ROOT,
    fetchNeutralSessions: deps.fetchNeutralSessions ?? ((distinctId, sessionId) =>
      fetchNeutralSessionsWithDomEnrichment(distinctId, sessionId, { progress })),
    fetchFullReplayStream: deps.fetchFullReplayStream ?? ((sessionId) => fetchFullReplayStream(sessionId, { progress })),
    renderCaptures: deps.renderCaptures ?? renderCaptures,
    fetchArchiveNeutralSessions: deps.fetchArchiveNeutralSessions ?? ((archiveDir, sessionId) =>
      createArchiveFetchers(archiveDir).fetchNeutralSessionsWithDomEnrichment(sessionId)),
    fetchArchiveFullReplayStream: deps.fetchArchiveFullReplayStream ?? fetchArchiveFullReplayStream,
    ...(deps.isFramesDirectoryIgnored === undefined ? {} : { isFramesDirectoryIgnored: deps.isFramesDirectoryIgnored }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    progress,
    log: deps.log ?? ((line: string) => console.log(line)),
  };
}

/**
 * `frames <slug>` uses a plan's own source session unless `--session` names a
 * deliberate alternate exemplar. Archive mode is intentionally undocumented
 * dogfood plumbing, but it passes the same neutral contracts to `frames.ts`.
 */
export async function runFramesCommand(argv: string[], deps: FramesCliRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'frames', deps.log)) return;
  const args = parseFramesArgs(argv);
  if (args.slug === undefined) {
    (deps.log ?? ((line: string) => console.log(line)))(buildUsageError('frames'));
    process.exitCode = 1;
    return;
  }

  const resolved = resolveFramesRunDeps(deps);
  const archiveDir = args.fromArchive;
  const result = await runFrames(
    {
      slug: args.slug,
      ...(args.session === undefined ? {} : { sessionId: args.session }),
      ...(args.steps === undefined ? {} : { steps: args.steps }),
      all: args.all,
      allowUnignored: args.allowUnignored,
    },
    {
      ...resolved,
      fetchNeutralSessions:
        archiveDir === undefined
          ? resolved.fetchNeutralSessions
          : (_distinctId, sessionId) => resolved.fetchArchiveNeutralSessions(archiveDir, sessionId ?? ''),
      fetchFullReplayStream:
        archiveDir === undefined
          ? resolved.fetchFullReplayStream
          : async (sessionId) => await Promise.resolve(resolved.fetchArchiveFullReplayStream(archiveDir, sessionId)),
    },
  );

  for (const line of formatFramesRunResult(result)) resolved.log(line);
  if (result.kind === 'refusal') process.exitCode = result.exitCode;
}
