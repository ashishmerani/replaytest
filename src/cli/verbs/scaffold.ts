import * as fs from 'node:fs';
import * as path from 'node:path';
import { emitArtifact } from '../../artifact-registry.js';
import { renderPlanMarkdown, renderScaffoldSpec, type Sidecar } from '../../sidecar.js';
import { stampEmittedSpecHash } from '../../spec-emitted-hashes.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, parseScaffoldArgs, type ScaffoldArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { GENERATED_TESTS_DIR, PLANS_DIR, RETIRED_DIR, SPEC_EMITTED_HASHES_PATH, WORKSPACE_ROOT } from '../paths.js';
import { appendRetiredAwareness, readRetiredRecord, retiredDoorSentence, retirementRecoveryMessage } from '../retired-awareness.js';
import { acquireStateLock, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, verifyStateLock, type StateLockHandle } from '../../state-lock.js';
import { createStatePublicationLedger, makeStateArtifactWriter, releaseStateLockWithDisclosure, type StatePublicationLedger } from '../../state-writes.js';

/** `scaffold`'s refusal when the target spec already exists and neither `--force` nor `--out` was given — scaffold is a one-shot generator: once a spec is generated and hand-finished, it's the user's, and a re-scaffold never silently overwrites it. Names the two explicit escape hatches. Pure. */
export function buildScaffoldExistsError(specDisplay: string): string {
  return [
    `${specDisplay} already exists — refusing to overwrite a finished test.`,
    '  Pass --force to overwrite it, or --out <path> to write a new file to diff.',
  ].join('\n');
}

function assertRetirementWriteAllowed(slug: string, retiredDir: string): void {
  const recovery = retirementRecoveryMessage(slug, retiredDir);
  if (recovery !== undefined) throw new Error(recovery);
}

/** The pure overwrite decision shared by scaffold's default target and explicit `--out <path>` target. `--force` is the only override; otherwise any existing target is refused. */
export function shouldRefuseScaffoldTarget(args: Pick<ScaffoldArgs, 'force'>, targetExists: boolean): boolean {
  return targetExists && !args.force;
}

/** `scaffold`'s error when `<slug>.plan.json` doesn't exist yet — points at `plan`, never a raw fs stack trace (spec-mandated wording). Pure. */
export function buildMissingSidecarError(slug: string): string {
  return `No plan found for "${slug}" — run: ${TOOL_NAME} plan <distinctId>.`;
}





/** A short hand-off while the recording is still likely retained. */
export function formatFramesTip(slug: string): string {
  return `Tip: ${TOOL_NAME} frames ${slug} — per-step DOM + screenshots for your coding agent (recordings expire; run it early).`;
}

/** `scaffold`'s confirmation lines — the generated spec (at `specDisplay`, defaulting to the standard `tests/generated/<slug>.spec.ts` path; a `--out <path>` run passes the chosen path instead), and the plan.md it re-rendered so .json / .md / .spec.ts stay consistent after an edit. Pure. */
export function formatScaffoldWrittenLines(slug: string, specDisplay = `tests/generated/${slug}.spec.ts`): string[] {
  return [`Wrote ${specDisplay}`, `Wrote .replaytest/plans/${slug}.md`];
}

export interface ScaffoldRunDeps {
  plansDir?: string;
  generatedTestsDir?: string;
  workspaceRoot?: string;
  specEmittedHashesPath?: string;
  retiredDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** Test seam: observes the persisted lease after acquisition. */
  onAcquired?: (handle: StateLockHandle) => void;
}

function resolveScaffoldRunDeps(
  deps: ScaffoldRunDeps,
): Required<Pick<ScaffoldRunDeps, 'plansDir' | 'generatedTestsDir' | 'workspaceRoot' | 'specEmittedHashesPath' | 'now' | 'log'>> & { retiredDir: string; onAcquired?: (handle: StateLockHandle) => void } {
  return {
    plansDir: deps.plansDir ?? PLANS_DIR,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    workspaceRoot: deps.workspaceRoot ?? WORKSPACE_ROOT,
    specEmittedHashesPath: deps.specEmittedHashesPath ?? SPEC_EMITTED_HASHES_PATH,
    retiredDir: deps.retiredDir ?? RETIRED_DIR,
    now: deps.now ?? (() => new Date()),
    log: deps.log ?? ((line: string) => console.log(line)),
    ...(deps.onAcquired === undefined ? {} : { onAcquired: deps.onAcquired }),
  };
}

/**
 * `scaffold <slug>`: reads `.replaytest/plans/<slug>.plan.json` as the single
 * source of truth — never a re-fetch, which would
 * ignore the human's edits — and writes `tests/generated/<slug>.spec.ts` +
 * re-renders `<slug>.md`, so `.json` / `.md` / `.spec.ts` stay consistent
 * after an edit. Sync — no network. A missing sidecar or anything else that
 * goes wrong prints a clear one-line message, never a raw stack trace.
 */
export function runScaffold(argv: string[], deps: ScaffoldRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'scaffold', deps.log)) return;
  const resolvedDeps = resolveScaffoldRunDeps(deps);
  const args = parseScaffoldArgs(argv);
  if (args.slug === undefined) {
    resolvedDeps.log(buildUsageError('scaffold'));
    process.exitCode = 1;
    return;
  }
  const slug = args.slug;

  const target = resolveScaffoldTarget(slug, args, resolvedDeps);
  if (target === undefined) return;

  try {
    withScaffoldStateLock(resolvedDeps, args.stealStateLock === true, (stateLockHandle, publicationLedger) => {
      const sidecar = JSON.parse(fs.readFileSync(target.sidecarPath, 'utf8')) as Sidecar;

      fs.mkdirSync(path.dirname(target.specPath), { recursive: true });
      assertRetirementWriteAllowed(slug, resolvedDeps.retiredDir);
      verifyStateLock(stateLockHandle);
      emitArtifact('scaffold-spec', target.specPath, renderScaffoldSpec(sidecar, slug), { privacyDisclosure: sidecar.privacyDisclosure });
      // An explicit --out is a disposable comparison artifact, not this slug's
      // canonical generated spec, so it intentionally never changes the marker.
      if (args.out === undefined) {
        assertRetirementWriteAllowed(slug, resolvedDeps.retiredDir);
        verifyStateLock(stateLockHandle);
        stampEmittedSpecHash(
          resolvedDeps.specEmittedHashesPath,
          resolvedDeps.workspaceRoot,
          slug,
          target.specPath,
          sidecar,
          resolvedDeps.now().toISOString(),
          makeStateArtifactWriter({ stateLockHandle, publicationLedger }),
        );
      }
      assertRetirementWriteAllowed(slug, resolvedDeps.retiredDir);
      verifyStateLock(stateLockHandle);
      emitArtifact('plan-md', path.join(resolvedDeps.plansDir, `${slug}.md`), `${renderPlanMarkdown(sidecar)}\n`, { privacyDisclosure: sidecar.privacyDisclosure });

      for (const line of formatScaffoldWrittenLines(slug, args.out)) resolvedDeps.log(line);
      resolvedDeps.log(formatFramesTip(slug));
    });
  } catch (err) {
    const lockRefusal = translateScaffoldLockError(err);
    if (lockRefusal !== undefined) {
      resolvedDeps.log(lockRefusal);
      process.exitCode = 1;
      return;
    }
    resolvedDeps.log(`Could not scaffold "${slug}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

interface ScaffoldTarget {
  sidecarPath: string;
  specPath: string;
}

type ResolvedScaffoldRunDeps = ReturnType<typeof resolveScaffoldRunDeps>;

function resolveScaffoldTarget(
  slug: string,
  args: ScaffoldArgs,
  resolvedDeps: ResolvedScaffoldRunDeps,
): ScaffoldTarget | undefined {
  const recovery = retirementRecoveryMessage(slug, resolvedDeps.retiredDir);
  if (recovery !== undefined) {
    resolvedDeps.log(recovery);
    process.exitCode = 1;
    return undefined;
  }

  const sidecarPath = path.join(resolvedDeps.plansDir, `${slug}.plan.json`);
  if (!fs.existsSync(sidecarPath)) {
    resolvedDeps.log(appendRetiredAwareness(slug, buildMissingSidecarError(slug), resolvedDeps.retiredDir));
    process.exitCode = 1;
    return undefined;
  }

  // Re-planning a retired slug IS the sanctioned fresh start. Disclose the
  // prior retirement and proceed — never block a re-plan, but never hide the record.
  const retiredRecord = readRetiredRecord(slug, resolvedDeps.retiredDir);
  if (retiredRecord !== undefined) {
    resolvedDeps.log(`ⓘ ${retiredDoorSentence(slug, retiredRecord)} Re-scaffolding proceeds — this is a fresh start.`);
  }

  // Scaffold is a one-shot generator: the generated spec is a
  // STARTING artifact — once the user's agent completes the finishing steps in it (masked
  // fills, richer assertions), that file is theirs. So a re-scaffold NEVER silently
  // overwrites the default spec: `--force` is an explicit overwrite decision, `--out`
  // writes a fresh file to diff. The `.replaytest/plans/<slug>.md` below is a rendered
  // projection of the sidecar (never hand-edited — edits go in the `.plan.json`), so it
  // is always re-rendered.
  const defaultSpecPath = path.join(resolvedDeps.generatedTestsDir, `${slug}.spec.ts`);
  const specPath = args.out !== undefined ? path.resolve(args.out) : defaultSpecPath;
  const specDisplay = args.out !== undefined ? args.out : `tests/generated/${slug}.spec.ts`;
  if (shouldRefuseScaffoldTarget(args, fs.existsSync(specPath))) {
    resolvedDeps.log(buildScaffoldExistsError(specDisplay));
    process.exitCode = 1;
    return undefined;
  }
  return { sidecarPath, specPath };
}

function withScaffoldStateLock<T>(resolvedDeps: ResolvedScaffoldRunDeps, stealStateLock: boolean, run: (handle: StateLockHandle, publicationLedger: StatePublicationLedger) => T): T {
  const handle = acquireStateLock(
    path.join(resolvedDeps.workspaceRoot, '.replaytest', 'state'),
    'scaffold',
    { onProgress: resolvedDeps.log, onAcquired: resolvedDeps.onAcquired },
    stealStateLock,
  );
  const publicationLedger = createStatePublicationLedger();
  try {
    return run(handle, publicationLedger);
  } finally {
    releaseStateLockWithDisclosure(handle, publicationLedger, 'scaffold', resolvedDeps.log);
  }
}

function translateScaffoldLockError(error: unknown): string | undefined {
  if (error instanceof StateLockFencedError) return stateLockFencedMessage('scaffold');
  if (error instanceof StateLockHeldError) return stateLockHeldMessage('scaffold', error.info, error.deadHolder);
  return undefined;
}
