import { acceptProposal, formatAcceptJson, formatAcceptRefusalJson, formatAcceptResult, renderAcceptRefusal } from '../../accept.js';
import { buildHandFinishedRegistryRefusal, isHandFinishedRegistryInvalid, readHandFinishedRegistry } from '../../hand-finished.js';
import type { StateLockHandle } from '../../state-lock.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, emitUsageError, parseAcceptArgs } from '../args.js';
import { PLANS_DIR, WORKSPACE_ROOT } from '../paths.js';

export interface AcceptRunDeps {
  plansDir?: string;
  workspaceRoot?: string;
  retiredDir?: string;
  log?: (line: string) => void;
  /** Lock progress stays on stderr so `accept --json` is one JSON document. */
  progress?: (line: string) => void;
  /** Test seam: observes the persisted lease after acquisition. */
  onAcquired?: (handle: StateLockHandle) => void;
  now?: () => Date;
  handFinishedSlugs?: ReadonlySet<string>;
}

function resolveAcceptRunDeps(deps: AcceptRunDeps): Required<Pick<AcceptRunDeps, 'plansDir' | 'log' | 'progress'>> & {
  onAcquired?: (handle: StateLockHandle) => void;
  now?: () => Date;
  retiredDir?: string;
  handFinishedSlugs: ReadonlySet<string>;
  handFinishedRegistryError?: string;
} {
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const registry = deps.handFinishedSlugs === undefined
    ? readHandFinishedRegistry(workspaceRoot)
    : { slugs: deps.handFinishedSlugs, entries: [] };
  return {
    plansDir: deps.plansDir ?? PLANS_DIR,
    log: deps.log ?? ((line: string) => console.log(line)),
    progress: deps.progress ?? ((line: string) => console.error(line)),
    ...(deps.onAcquired === undefined ? {} : { onAcquired: deps.onAcquired }),
    handFinishedSlugs: isHandFinishedRegistryInvalid(registry) ? new Set<string>() : registry.slugs,
    ...(isHandFinishedRegistryInvalid(registry) ? { handFinishedRegistryError: registry.error } : {}),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.retiredDir === undefined ? {} : { retiredDir: deps.retiredDir }),
  };
}

export function runAccept(argv: string[], deps: AcceptRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'accept', deps.log)) return;
  const resolvedDeps = resolveAcceptRunDeps(deps);
  const args = parseAcceptArgs(argv);
  if (args.slug === undefined) {
    emitUsageError(args.json, buildUsageError('accept'), resolvedDeps.log);
    process.exitCode = 1;
    return;
  }
  if (resolvedDeps.handFinishedRegistryError !== undefined) {
    const refusal = {
      kind: 'refusal' as const,
      code: 'invalid-hand-finished-registry' as const,
      message: buildHandFinishedRegistryRefusal(resolvedDeps.handFinishedRegistryError),
      exitCode: 1 as const,
    };
    resolvedDeps.log(args.json ? formatAcceptRefusalJson(refusal).trimEnd() : renderAcceptRefusal(refusal));
    process.exitCode = refusal.exitCode;
    return;
  }

  const result = acceptProposal({
    slug: args.slug,
    plansDir: resolvedDeps.plansDir,
    force: args.force,
    confirmDifferentJourney: args.confirmDifferentJourney,
    workspaceRoot: deps.workspaceRoot ?? WORKSPACE_ROOT,
    ...(resolvedDeps.retiredDir === undefined ? {} : { retiredDir: resolvedDeps.retiredDir }),
    now: resolvedDeps.now,
    handFinishedSlugs: resolvedDeps.handFinishedSlugs,
    ...(args.stealStateLock === true ? { stealStateLock: true } : {}),
    progress: resolvedDeps.progress,
    onAcquired: resolvedDeps.onAcquired,
    log: resolvedDeps.log,
  });

  if (result.kind === 'refusal') {
    resolvedDeps.log(args.json ? formatAcceptRefusalJson(result).trimEnd() : renderAcceptRefusal(result));
    process.exitCode = result.exitCode;
    return;
  }

  resolvedDeps.log(args.json ? formatAcceptJson(result).trimEnd() : formatAcceptResult(result));
}
