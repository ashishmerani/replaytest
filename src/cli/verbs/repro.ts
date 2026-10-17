// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { emitArtifact } from '../../artifact-registry.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { fetchNeutralSessionsWithDomEnrichment, getProviderConfigStatus, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { segmentJourneys, type JourneyStatus } from '../../journeys.js';
import type { NeutralSession } from '../../neutral-session.js';
import { attributeExceptions, type AttributedExceptions } from '../../journey-evidence.js';
import { buildReproSpec } from '../../repro-builder.js';
import { maybePrintVerbHelp } from '../help.js';
import { TOOL_NAME } from '../constants.js';
import { buildUsageError, parseReproArgs } from '../args.js';
import { REPRODUCTIONS_DIR } from '../paths.js';
import { dedupeSlug, slugifyJourneyRoute } from '../slug.js';
import { buildPlanSessionNotFoundMessage, selectPlanSession } from '../plan-session.js';
import { formatJourneyStatusToken } from '../terminal-format.js';
import { buildScaffoldExistsError, shouldRefuseScaffoldTarget } from './scaffold.js';

// ---------------------------------------------------------------------------
// repro — argument parsing, exception header, and artifact building. The fetch/fs
// work happens only in `runRepro` below.
//
// `repro` is CLI exposure of the existing Tier-0 mechanical repro emitter
// (`src/repro-builder.ts` `buildReproSpec`) — reused VERBATIM: this file
// never re-implements the emitter, it only (1) drives it per journey of ANY
// status (`segmentJourneys`, not `selectCompletedJourneys` — an
// error/abandoned journey is exactly the Path-B point), (2) splices an
// exception-summary header comment into the emitted source when the
// shared `attributeExceptions` time-window attribution (the same one
// `sessions --with-exceptions` reuses) finds >=1 exception
// attributed to that journey, and (3) applies scaffold-class overwrite
// guardrails — reusing `shouldRefuseScaffoldTarget`/`buildScaffoldExistsError`
// directly rather than forking a second copy, since the refusal semantics are
// identical: a repro spec is also a starting artifact a human may edit.
// ---------------------------------------------------------------------------

/**
 * `repro`'s message when the fetched session segmented into zero journeys (no
 * click/input/submit at all) — nothing to reproduce. The session is genuinely
 * empty, so this does not pretend a retry exists: it sends the reader to the
 * session list, where which sessions actually have activity is visible at a
 * glance. Pure.
 */
export function buildNoJourneysFoundMessage(): string {
  return (
    'No journeys found in the session — nothing to reproduce. ' +
    `This session recorded no clicks, inputs, or submits; pick a different session with \`${TOOL_NAME} sessions\` ` +
    '(look for completed/navigated/submitted activity) and re-run repro against it.'
  );
}

/** `repro --out`'s refusal when the target session segmented into MORE than one journey: a single `--out <path>` target cannot deterministically receive N repro specs, so `repro` refuses rather than silently picking one or clobbering. Omitting `--out` still writes every journey to its own default `tests/reproductions/<slug>.repro.spec.ts` path. Pure. */
export function buildReproMultiJourneyOutError(journeyCount: number): string {
  return (
    `--out only supports a single-journey session — this session has ${journeyCount} journeys. ` +
    'Omit --out to write each journey to its own default tests/reproductions/<slug>.repro.spec.ts path.'
  );
}

/** The header comment lines spliced into a repro spec's source when the journey's time window witnessed >=1 exception (`attributeExceptions`, reused verbatim) — `undefined` when nothing attributes, so a clean journey's repro renders byte-for-byte what `buildReproSpec` alone already emits. Pure. */
export function buildReproExceptionHeader(attributed: AttributedExceptions): string[] | undefined {
  if (attributed.count === 0) return undefined;
  const noun = attributed.count === 1 ? 'exception' : 'exceptions';
  return [
    `// The recorded session witnessed ${attributed.count} ${noun} (${attributed.types.join(', ')}) during this journey —`,
    '// this repro re-drives the same steps; watch for the same failure.',
  ];
}

/** Splices `header` immediately after `buildReproSpec`'s own first (import) line — ahead of the blank line + `test(...)` — so the exception summary is the first thing a human reading the file sees, without touching `buildReproSpec` itself. This is post-processing of its output, not a change to its behavior. No-op (`spec` returned unchanged) when `header` is `undefined`. Pure. */
export function injectReproHeader(spec: string, header: string[] | undefined): string {
  if (header === undefined) return spec;
  const lines = spec.split('\n');
  const importLineIndex = lines.findIndex((line) => line.startsWith('import'));
  const insertAt = importLineIndex === -1 ? 0 : importLineIndex + 1;
  lines.splice(insertAt, 0, ...header);
  return lines.join('\n');
}

interface ReproFetchers {
  fetchNeutralSessionsWithDomEnrichment: (distinctId: string, sessionId?: string) => Promise<NeutralSession[]>;
}

export interface ReproRunDeps extends Partial<ReproFetchers> {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  reproductionsDir?: string;
  /** Progress stays on stderr so future machine output remains clean. */
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

function resolveReproRunDeps(deps: ReproRunDeps): ReproFetchers & {
  getProviderConfigStatus: () => ProviderConfigStatus;
  reproductionsDir: string;
  progress: (line: string) => void;
  log: (line: string) => void;
} {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const resolved: ReproFetchers & {
    getProviderConfigStatus: () => ProviderConfigStatus;
    reproductionsDir: string;
    progress: (line: string) => void;
    log: (line: string) => void;
  } = {
    getProviderConfigStatus,
    fetchNeutralSessionsWithDomEnrichment: (distinctId, sessionId) =>
      fetchNeutralSessionsWithDomEnrichment(distinctId, sessionId, { progress }),
    reproductionsDir: REPRODUCTIONS_DIR,
    progress,
    log: (line) => console.log(line),
  };
  if (deps.getProviderConfigStatus !== undefined) resolved.getProviderConfigStatus = deps.getProviderConfigStatus;
  if (deps.fetchNeutralSessionsWithDomEnrichment !== undefined) {
    resolved.fetchNeutralSessionsWithDomEnrichment = deps.fetchNeutralSessionsWithDomEnrichment;
  }
  if (deps.reproductionsDir !== undefined) resolved.reproductionsDir = deps.reproductionsDir;
  if (deps.progress !== undefined) resolved.progress = deps.progress;
  if (deps.log !== undefined) resolved.log = deps.log;
  return resolved;
}

interface ReproWriteTarget {
  slug: string;
  status: JourneyStatus;
  spec: string;
  specPath: string;
  specDisplay: string;
}

/**
 * `repro <distinctId>`: preflight config, require the positional, fetch via
 * `fetchNeutralSessionsWithDomEnrichment` (the same entry `plan` uses — DOM-
 * recovered selectors, scoped when `--session` is given), select either
 * the first fetched session or the exact `--session <sessionId>` match
 * (`selectPlanSession`, reused), then emit ONE `buildReproSpec` per journey of
 * ANY status — with an exception header spliced in when the journey's
 * window witnessed one — preflight every target with the scaffold-class
 * overwrite guardrails, and only then write. Async — the one network
 * call; the router below awaits it.
 */
export async function runRepro(argv: string[], deps: ReproRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'repro', deps.log)) return;
  const resolvedDeps = resolveReproRunDeps(deps);
  const status = resolvedDeps.getProviderConfigStatus();
  if (!isConfigured(status)) {
    resolvedDeps.log(buildUnconfiguredHint());
    return;
  }

  const args = parseReproArgs(argv);
  if (args.distinctId === undefined) {
    resolvedDeps.log(buildUsageError('repro'));
    process.exitCode = 1;
    return;
  }
  const distinctId = args.distinctId;

  const sessions = await resolvedDeps.fetchNeutralSessionsWithDomEnrichment(distinctId, args.session);
  const session = selectPlanSession(sessions, args.session);
  if (session === undefined) {
    resolvedDeps.log(
      args.session === undefined
        ? `No session found for distinct_id ${distinctId}`
        : buildPlanSessionNotFoundMessage(distinctId, args.session, 'repro'),
    );
    if (args.session !== undefined) process.exitCode = 1;
    return;
  }

  const journeys = segmentJourneys(session);
  if (journeys.length === 0) {
    resolvedDeps.log(buildNoJourneysFoundMessage());
    process.exitCode = 1;
    return;
  }

  if (args.out !== undefined && journeys.length > 1) {
    resolvedDeps.log(buildReproMultiJourneyOutError(journeys.length));
    process.exitCode = 1;
    return;
  }

  const usedSlugs = new Set<string>();
  const targets: ReproWriteTarget[] = journeys.map((journey) => {
    const slug = dedupeSlug(slugifyJourneyRoute(journey.finalUrl), usedSlugs);
    usedSlugs.add(slug);

    const header = buildReproExceptionHeader(attributeExceptions(journey, session.witnessedExceptions));
    const spec = injectReproHeader(buildReproSpec(journey, session.maskedFields), header);

    const specPath = args.out !== undefined
      ? path.resolve(args.out)
      : path.join(resolvedDeps.reproductionsDir, `${slug}.repro.spec.ts`);
    const specDisplay = args.out !== undefined ? args.out : `tests/reproductions/${slug}.repro.spec.ts`;

    return { slug, status: journey.status, spec, specPath, specDisplay };
  });

  const refusals = targets.filter((target) => shouldRefuseScaffoldTarget(args, fs.existsSync(target.specPath)));
  if (refusals.length > 0) {
    for (const refusal of refusals) resolvedDeps.log(buildScaffoldExistsError(refusal.specDisplay));
    process.exitCode = 1;
    return;
  }

  for (const target of targets) {
    fs.mkdirSync(path.dirname(target.specPath), { recursive: true });
    emitArtifact('repro-spec', target.specPath, target.spec);
    resolvedDeps.log(`Wrote ${target.specDisplay} (${formatJourneyStatusToken(target.status)})`);
  }
}
