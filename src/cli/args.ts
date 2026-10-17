import { DEFAULT_PLAN_SAMPLE, MAX_PLAN_SAMPLE, TOOL_NAME } from './constants.js';
import { resolveRefreshTop } from '../selection.js';
import { CORE_SHAPE_NAMES, isCoreShapeName, type CoreShapeName } from '../shapes.js';
import { buildVerbUsageLine, findUnknownVerbFlag, isVerbName, verbSupportsJson, type VerbName } from './help.js';

/** The shipped refusal envelope used whenever `--json` reaches argument validation. */
export function usageErrorEnvelope(message: string): { error: { code: 'usage-error'; message: string } } {
  return { error: { code: 'usage-error', message } };
}

export function formatUsageErrorJson(message: string): string {
  return JSON.stringify(usageErrorEnvelope(message), null, 2);
}

/** Preserve human usage prose while making the same message machine-readable in JSON mode. */
export function emitUsageError(json: boolean, message: string, log: (line: string) => void): void {
  log(json ? formatUsageErrorJson(message) : message);
}

/** Shared unknown-flag copy for every verb; the caller chooses prose or JSON rendering. */
export function buildUnknownFlagUsageError(verb: VerbName, flag: string, usageLine = buildVerbUsageLine(verb)): string {
  return `Unknown flag: ${flag}.\n${usageLine}`;
}

export interface RefuseUnknownFlagDeps {
  log?: (line: string) => void;
}

/** Refuse the first unknown long flag before a verb can read workspace state or start work. */
export function refuseUnknownFlag(command: string | undefined, rest: readonly string[], deps: RefuseUnknownFlagDeps = {}): boolean {
  if (!isVerbName(command) || rest.includes('--help') || rest.includes('-h')) return false;
  const unknownFlag = findUnknownVerbFlag(rest, command);
  if (unknownFlag === undefined) return false;
  const jsonEngaged = verbSupportsJson(command) && rest.includes('--json');
  emitUsageError(jsonEngaged, buildUnknownFlagUsageError(command, unknownFlag), deps.log ?? ((line: string) => console.log(line)));
  process.exitCode = 1;
  return true;
}

/** The value immediately after `flag` in `argv`, or `undefined` if `flag` is absent or is the last element. Shared by every value-carrying flag this CLI reads. */
export function readFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** `readFlagValue`, parsed as a number — `undefined` when absent OR not a valid number (same NaN guard idiom as selection.ts's `--since-hours` parsing). */
function readNumberFlag(argv: string[], flag: string): number | undefined {
  const raw = readFlagValue(argv, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** `init`'s parsed flags. `host` (open-item — configurable PostHog host for EU/self-hosted) is optional; omitting it leaves the configured host (or the `us.posthog.com` default) untouched. */
export interface InitArgs {
  project?: string;
  token?: string;
  host?: string;
}

/** Parses `replaytest init [--project <id>] [--token <key>] [--host <host>]`. Pure — no I/O. */
export function parseInitArgs(argv: string[]): InitArgs {
  return {
    project: readFlagValue(argv, '--project'),
    token: readFlagValue(argv, '--token'),
    host: readFlagValue(argv, '--host'),
  };
}

/** `sessions`'s parsed flags. */
export interface SessionsArgs {
  app?: string;
  completed: boolean;
  navigated: boolean;
  submitted: boolean;
  withExceptions: boolean;
  shapes: string[];
  families: boolean;
  gapsOnly: boolean;
  stored: boolean;
  exact: boolean;
  json: boolean;
  replayAvailability: boolean;
  fresh: boolean;
  fromArchive?: string;
  archiveSessionId?: string;
  sinceHours?: number;
  limit?: number;
  all?: boolean;
  pageSize?: number;
  maxPages?: number;
  refreshTop: number;
  stealScanLock?: boolean;
}

/** Parses `replaytest sessions [--completed] [--navigated] [--submitted] [--with-exceptions] [--shape <name>] [--exact] [--json] [--since-hours N] [--limit N]`. Pure — no I/O. */
export function parseSessionsArgs(argv: string[]): SessionsArgs {
  const fromArchive = readFlagValue(argv, '--from-archive');
  const archiveSessionId = argv.find((arg, i) => !arg.startsWith('--') && !isValueForSessionsFlag(argv, i));
  return {
    completed: argv.includes('--completed'),
    navigated: argv.includes('--navigated'),
    submitted: argv.includes('--submitted'),
    withExceptions: argv.includes('--with-exceptions'),
    shapes: readSessionsFlagValues(argv, '--shape'),
    families: argv.includes('--families'),
    gapsOnly: argv.includes('--gaps-only'),
    stored: argv.includes('--stored'),
    exact: argv.includes('--exact'),
    json: argv.includes('--json'),
    replayAvailability: argv.includes('--replay-availability'),
    fresh: argv.includes('--fresh'),
    ...(readFlagValue(argv, '--app') === undefined ? {} : { app: readFlagValue(argv, '--app') }),
    ...(fromArchive === undefined ? {} : { fromArchive }),
    ...(archiveSessionId === undefined ? {} : { archiveSessionId }),
    sinceHours: readNumberFlag(argv, '--since-hours'),
    limit: readNumberFlag(argv, '--limit'),
    ...(argv.includes('--all') ? { all: true } : {}),
    pageSize: readNumberFlag(argv, '--page-size'),
    maxPages: readNumberFlag(argv, '--max-pages'),
    refreshTop: resolveRefreshTop(readNumberFlag(argv, '--refresh-top')),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

/** Collects values from a repeatable sessions-only flag without mistaking a following flag for its value. */
function readSessionsFlagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => {
    if (arg !== flag) return [];
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? [] : [value];
  });
}

function isValueForSessionsFlag(argv: string[], index: number): boolean {
  const previous = argv[index - 1];
  return (
    previous === '--from-archive' ||
    previous === '--app' ||
    previous === '--shape' ||
    previous === '--since-hours' ||
    previous === '--limit' ||
    previous === '--page-size' ||
    previous === '--max-pages' ||
    previous === '--refresh-top' ||
    previous === '--interval' ||
    previous === '--max-ticks'
  );
}

/** Parsed flags for the read-only core traffic-signal link map. */
export interface GapsArgs {
  app?: string;
  shapes: string[];
  json: boolean;
  fresh: boolean;
  stored: boolean;
  exact: boolean;
  refreshSample: boolean;
  sampleSize?: number;
  sinceHours?: number;
  limit?: number;
  all?: boolean;
  stealScanLock?: boolean;
}

/** Parses `replaytest gaps [--shape <name>]... [--refresh-sample] [--sample-size N] [--json] [--fresh] [--stored] [--exact] [--since-hours N] [--limit N]`. */
export function parseGapsArgs(argv: string[]): GapsArgs {
  return {
    shapes: readGapsShapeValues(argv),
    json: argv.includes('--json'),
    fresh: argv.includes('--fresh'),
    ...(readFlagValue(argv, '--app') === undefined ? {} : { app: readFlagValue(argv, '--app') }),
    stored: argv.includes('--stored'),
    exact: argv.includes('--exact'),
    refreshSample: argv.includes('--refresh-sample'),
    sampleSize: readNumberFlag(argv, '--sample-size'),
    sinceHours: readNumberFlag(argv, '--since-hours'),
    limit: readNumberFlag(argv, '--limit'),
    ...(argv.includes('--all') ? { all: true } : {}),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

function readGapsShapeValues(argv: string[]): string[] {
  return argv.flatMap((arg, index) => {
    if (arg !== '--shape') return [];
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? [] : [value];
  });
}

/** Loudly refuses unknown or value-less `--shape` flags before a provider fetch. */
export function buildShapeUsageError(value?: string): string {
  const problem = value === undefined ? '--shape requires a name.' : `Unknown shape "${value}".`;
  return `${problem} Supported shapes: ${CORE_SHAPE_NAMES.join(', ')}.`;
}

export function resolveRequestedShapes(argv: string[], values: string[]): { shapes?: CoreShapeName[]; error?: string } {
  const hasMissingValue = argv.some(
    (arg, index) => arg === '--shape' && (argv[index + 1] === undefined || argv[index + 1]?.startsWith('--')),
  );
  if (hasMissingValue) return { error: buildShapeUsageError() };
  const unknown = values.find((value) => !isCoreShapeName(value));
  if (unknown !== undefined) return { error: buildShapeUsageError(unknown) };
  return { shapes: [...new Set(values)] as CoreShapeName[] };
}

/** `plan`/`scaffold` each require exactly one bare positional (a distinctId or a slug) — never a `--flag`. `undefined` when `argv` has no non-flag token at all. Pure. */
export function readRequiredPositional(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith('--'));
}

/** `plan`/`scaffold`/`repro`/`accept`'s usage line when the required positional is missing — mirrors `sessions`' "print a clear hint, never crash" ergonomics. Pure. */
export function buildUsageError(command: 'plan' | 'scaffold' | 'frames' | 'preflight' | 'triage' | 'regenerate' | 'diff' | 'repro' | 'accept' | 'fix-selector' | 'sessions-archive' | 'sessions-output-cap' | 'gaps-output-cap' | 'retire' | 'auth-setup'): string {
  if (command === 'plan') {
    return `Usage: ${TOOL_NAME} plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-cross-origin] [--allow-privacy-disclosure] [--steal-scan-lock]`;
  }
  if (command === 'sessions-archive') {
    return `Usage: ${TOOL_NAME} sessions <sessionId> --from-archive <dir>`;
  }
  if (command === 'sessions-output-cap') {
    return buildVerbUsageLine('sessions');
  }
  if (command === 'gaps-output-cap') {
    return buildVerbUsageLine('gaps');
  }
  if (command === 'triage') {
    return `Usage: ${TOOL_NAME} triage <slug> [--sample N] [--since-hours N] [--app <name>] [--propose] [--force] [--json] [--steal-state-lock] [--steal-scan-lock] [--reuse-evidence [--max-age <duration>]]`;
  }
  if (command === 'regenerate') {
    return `Usage: ${TOOL_NAME} regenerate <slug> [--since-hours N] [--app <name>] [--allow-cross-origin] [--json] [--steal-scan-lock]`;
  }
  if (command === 'diff') {
    return `Usage: ${TOOL_NAME} diff <slug> [--json]`;
  }
  if (command === 'preflight') {
    return `Usage: ${TOOL_NAME} preflight <slug> [--json]`;
  }
  if (command === 'fix-selector') {
    return `Usage: ${TOOL_NAME} fix-selector <slug> [--apply] [--dry-run] [--occurrence N] [--prefer stability|fidelity] [--from-triage-verdict] [--allow-privacy-disclosure] [--json] [--steal-state-lock]`;
  }
  if (command === 'repro') {
    return `Usage: ${TOOL_NAME} repro <distinctId> [--session <sessionId>] [--out <path>] [--force]`;
  }
  if (command === 'accept') {
    return `Usage: ${TOOL_NAME} accept <slug> [--force] [--confirm-different-journey] [--json] [--steal-state-lock]`;
  }
  if (command === 'frames') {
    return `Usage: ${TOOL_NAME} frames <slug> [--from-archive <dir>] [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]`;
  }
  if (command === 'retire') {
    return `Usage: ${TOOL_NAME} retire <slug> [--confirm-retire] [--no-evidence] [--steal-lock] [--steal-state-lock] [--recover-crashed-locks] [--allow-privacy-disclosure] [--json]`;
  }
  if (command === 'auth-setup') {
    return `Usage: ${TOOL_NAME} auth-setup [--allow-privacy-disclosure]`;
  }
  return `Usage: ${TOOL_NAME} scaffold <slug>`;
}

/** `plan`'s parsed args: the required `<distinctId>` positional, optional exact session id, bounded sample count, and explicit overwrite flag. The positional finder skips value-carrying plan flags so their values are never mistaken for the distinctId. Pure. */
export interface PlanArgs {
  distinctId?: string;
  session?: string;
  fromArchive?: string;
  sample: number;
  force: boolean;
  /** Reviewed opt-in past the witnessed-property boundary; same token `regenerate` uses. */
  allowCrossOrigin: boolean;
  allowPrivacyDisclosure?: boolean;
  stealScanLock?: boolean;
}

export function parsePlanArgs(argv: string[]): PlanArgs {
  const fromArchive = readFlagValue(argv, '--from-archive');
  return {
    distinctId: argv.find((arg, i) => !arg.startsWith('--') && !isValueForPlanFlag(argv, i)),
    session: readFlagValue(argv, '--session'),
    ...(fromArchive === undefined ? {} : { fromArchive }),
    sample: resolvePlanSample(readNumberFlag(argv, '--sample')),
    force: argv.includes('--force'),
    allowCrossOrigin: argv.includes('--allow-cross-origin'),
    ...(argv.includes('--allow-privacy-disclosure') ? { allowPrivacyDisclosure: true } : {}),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

function isValueForPlanFlag(argv: string[], index: number): boolean {
  const previous = argv[index - 1];
  return previous === '--session' || previous === '--sample' || previous === '--from-archive';
}

export function resolvePlanSample(value: number | undefined = DEFAULT_PLAN_SAMPLE): number {
  const raw = value ?? DEFAULT_PLAN_SAMPLE;
  if (!Number.isFinite(raw)) return DEFAULT_PLAN_SAMPLE;
  if (raw <= 0) return 0;
  return Math.min(Math.trunc(raw), MAX_PLAN_SAMPLE);
}

/** `scaffold`'s parsed args: the required `<slug>` positional plus the two overwrite-control flags. `--force` = an explicit decision to overwrite an existing spec; `--out <path>` = write a fresh file to diff instead. The positional finder skips the token immediately after `--out`, so a `--out <path>` value is never mistaken for the slug. Pure. */
export interface ScaffoldArgs {
  slug?: string;
  force: boolean;
  out?: string;
  stealStateLock?: boolean;
}

export function parseScaffoldArgs(argv: string[]): ScaffoldArgs {
  return {
    slug: argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--out'),
    force: argv.includes('--force'),
    out: readFlagValue(argv, '--out'),
    ...(argv.includes('--steal-state-lock') ? { stealStateLock: true } : {}),
  };
}

/** `frames` has one plan slug plus optional exemplar/targeting flags. The raw
 * range stays raw here; `frames.ts` owns validating and applying its capture
 * semantics so this entry point remains parsing and wiring only. */
export interface FramesArgs {
  slug?: string;
  session?: string;
  steps?: string;
  all: boolean;
  fromArchive?: string;
  allowUnignored: boolean;
}

export function parseFramesArgs(argv: string[]): FramesArgs {
  const fromArchive = readFlagValue(argv, '--from-archive');
  return {
    slug: argv.find((arg, index) => !arg.startsWith('--') && !isValueForFramesFlag(argv, index)),
    session: readFlagValue(argv, '--session'),
    steps: readFlagValue(argv, '--steps'),
    all: argv.includes('--all'),
    ...(fromArchive === undefined ? {} : { fromArchive }),
    allowUnignored: argv.includes('--allow-unignored'),
  };
}

function isValueForFramesFlag(argv: string[], index: number): boolean {
  const previous = argv[index - 1];
  return previous === '--session' || previous === '--steps' || previous === '--from-archive';
}

export interface TriageArgs {
  slug?: string;
  /** Confines the diagnosis to one declared app boundary; absent = the whole project. */
  app?: string;
  /**
   * The raw `--sample` value (unresolved), or `undefined` when the
   * flag is absent. Resolution/clamping/auto-widening are owned by
   * `collectTriageReport` — pre-resolving here erased the "flag absent" signal
   * the widen depends on and the ">MAX" signal the clamp note depends on.
   */
  sample: number | undefined;
  sinceHours?: number;
  propose: boolean;
  force: boolean;
  json: boolean;
  /** Opt-in fast path — re-derive the verdict from persisted evidence with no live fetches when it's fresh enough. */
  reuseEvidence: boolean;
  /** Raw `--max-age` value (unresolved) — `runTriage` parses it via `parseTriageMaxAge`, falling back to `DEFAULT_TRIAGE_REUSE_MAX_AGE_MS` on absence or an unparseable value. Only consulted when `reuseEvidence` is true. */
  maxAge?: string;
  stealStateLock?: boolean;
  stealScanLock?: boolean;
}

/** Parsed fresh-traffic repair flags. A regenerate always writes the single proposal slot; it has no --force overwrite escape hatch. */
export interface RegenerateArgs {
  slug?: string;
  sinceHours?: number;
  app?: string;
  allowCrossOrigin: boolean;
  json: boolean;
  stealScanLock?: boolean;
}

export function parseRegenerateArgs(argv: string[]): RegenerateArgs {
  return {
    slug: argv.find((arg, index) => !arg.startsWith('--') && !isValueForRegenerateFlag(argv, index)),
    sinceHours: readNumberFlag(argv, '--since-hours'),
    app: readFlagValue(argv, '--app'),
    allowCrossOrigin: argv.includes('--allow-cross-origin'),
    json: argv.includes('--json'),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

function isValueForRegenerateFlag(argv: string[], index: number): boolean {
  const previous = argv[index - 1];
  return previous === '--since-hours' || previous === '--app';
}

export function parseTriageArgs(argv: string[]): TriageArgs {
  return {
    slug: argv.find((arg, i) => !arg.startsWith('--') && !isValueForTriageFlag(argv, i)),
    app: readFlagValue(argv, '--app'),
    sample: readNumberFlag(argv, '--sample'),
    sinceHours: readNumberFlag(argv, '--since-hours'),
    propose: argv.includes('--propose'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    reuseEvidence: argv.includes('--reuse-evidence'),
    maxAge: readFlagValue(argv, '--max-age'),
    ...(argv.includes('--steal-state-lock') ? { stealStateLock: true } : {}),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

function isValueForTriageFlag(argv: string[], index: number): boolean {
  const previous = argv[index - 1];
  // `--app`'s value is a value, not the slug: without this rung
  // `triage --app shop` would diagnose a plan called "shop".
  return previous === '--sample' || previous === '--since-hours' || previous === '--max-age' || previous === '--app';
}

/** Parsed flags for the local, provider-free locator liveness preflight. */
export interface PreflightArgs {
  slug?: string;
  json: boolean;
}

export function parsePreflightArgs(argv: string[]): PreflightArgs {
  return { slug: readRequiredPositional(argv), json: argv.includes('--json') };
}

/** `auth-setup` has no user-facing flags in v1; the parser still records `--json` so the verb can refuse the deferred serializer explicitly. */
export interface AuthSetupArgs {
  json: boolean;
  allowPrivacyDisclosure?: boolean;
}

export function parseAuthSetupArgs(argv: string[]): AuthSetupArgs {
  return { json: argv.includes('--json'), ...(argv.includes('--allow-privacy-disclosure') ? { allowPrivacyDisclosure: true } : {}) };
}

/** Parsed flags for `diff <slug>` — the same slug-plus-`--json` shape `preflight` uses. */
export interface DiffArgs {
  slug?: string;
  json: boolean;
}

export function parseDiffArgs(argv: string[]): DiffArgs {
  return { slug: readRequiredPositional(argv), json: argv.includes('--json') };
}

/** `heal`'s parsed flags — no positional (it batch-processes every failure in the results file, not one slug). */
export interface HealArgs {
  results?: string;
  /** Confines every slug's diagnosis to one declared app boundary; absent = the whole project. */
  app?: string;
  /** Raw `--sample` (unresolved) or `undefined`; `collectHealReport` owns per-slug resolution/widening. */
  sample: number | undefined;
  sinceHours?: number;
  propose: boolean;
  force: boolean;
  allowStale: boolean;
  json: boolean;
  allowPrivacyDisclosure?: boolean;
  stealStateLock?: boolean;
  stealScanLock?: boolean;
}

export function parseHealArgs(argv: string[]): HealArgs {
  return {
    results: readFlagValue(argv, '--results'),
    app: readFlagValue(argv, '--app'),
    sample: readNumberFlag(argv, '--sample'),
    sinceHours: readNumberFlag(argv, '--since-hours'),
    propose: argv.includes('--propose'),
    force: argv.includes('--force'),
    allowStale: argv.includes('--allow-stale'),
    json: argv.includes('--json'),
    ...(argv.includes('--steal-state-lock') ? { stealStateLock: true } : {}),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

/** `accept`'s parsed args — one slug positional plus overwrite/output-mode flags. */
export interface AcceptArgs {
  slug?: string;
  force: boolean;
  confirmDifferentJourney: boolean;
  json: boolean;
  stealStateLock?: boolean;
}

export function parseAcceptArgs(argv: string[]): AcceptArgs {
  return {
    slug: readRequiredPositional(argv),
    force: argv.includes('--force'),
    confirmDifferentJourney: argv.includes('--confirm-different-journey'),
    json: argv.includes('--json'),
    ...(argv.includes('--steal-state-lock') ? { stealStateLock: true } : {}),
  };
}

/** `retire`'s parsed args: the required `<slug>` positional, two consent flags, and the `--json` envelope toggle. The parser rejects unknown flags — no generic rejector exists, so each verb owns its own. Pure. */
export interface RetireArgs {
  slug?: string;
  confirmRetire: boolean;
  noEvidence: boolean;
  stealLock: boolean;
  recoverCrashedLocks: boolean;
  json: boolean;
  stealStateLock?: boolean;
  allowPrivacyDisclosure?: boolean;
}

export function parseRetireArgs(argv: string[]): RetireArgs {
  return {
    slug: readRequiredPositional(argv),
    confirmRetire: argv.includes('--confirm-retire'),
    noEvidence: argv.includes('--no-evidence'),
    stealLock: argv.includes('--steal-lock'),
    recoverCrashedLocks: argv.includes('--recover-crashed-locks'),
    json: argv.includes('--json'),
    ...(argv.includes('--allow-privacy-disclosure') ? { allowPrivacyDisclosure: true } : {}),
    ...(argv.includes('--steal-state-lock') ? { stealStateLock: true } : {}),
  };
}

/** `suite-status`'s parsed flags — no positional (it's a reverse pass over every plan, not one slug). */
export interface SuiteStatusArgs {
  /** Confines the reverse pass to one declared app boundary; absent = the whole project. */
  app?: string;
  sinceHours?: number;
  json: boolean;
}

export function parseSuiteStatusArgs(argv: string[]): SuiteStatusArgs {
  return {
    app: readFlagValue(argv, '--app'),
    sinceHours: readNumberFlag(argv, '--since-hours'),
    json: argv.includes('--json'),
  };
}

/** `suite-health` is an inventory-first decision view. Coverage uses suite-status's ordinary scan window. */
export interface SuiteHealthArgs {
  /** Passed straight through to the coverage axis's suite-status pass; absent = the whole project. */
  app?: string;
  json: boolean;
}

export function parseSuiteHealthArgs(argv: string[]): SuiteHealthArgs {
  return { app: readFlagValue(argv, '--app'), json: argv.includes('--json') };
}

/** `reconcile` is non-mutating unless the user explicitly says `--apply`. */
export interface ReconcileArgs {
  apply: boolean;
  dryRun: boolean;
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const dryRun = argv.includes('--dry-run');
  return { apply: argv.includes('--apply') && !dryRun, dryRun };
}

/** `fix-selector` is non-mutating by default; `--dry-run` also wins over `--apply`. */
export interface FixSelectorArgs {
  slug?: string;
  apply: boolean;
  dryRun: boolean;
  occurrence?: number;
  occurrenceProvided: boolean;
  /** Opt-in verdict-apply mode tolerant of a prior hand-edit; only present when the flag is passed. */
  fromTriageVerdict?: boolean;
  /** Omitted means the default fidelity preference; present only for a valid explicit value. */
  prefer?: 'fidelity' | 'stability';
  /** Kept distinct from `prefer` so a malformed `--prefer` is refused, never silently defaulted. */
  preferProvided?: boolean;
  stealStateLock?: boolean;
  allowPrivacyDisclosure?: boolean;
  json?: boolean;
}

export function parseFixSelectorArgs(argv: string[]): FixSelectorArgs {
  const dryRun = argv.includes('--dry-run');
  const occurrenceRaw = readFlagValue(argv, '--occurrence');
  const parsedOccurrence = occurrenceRaw === undefined ? undefined : Number(occurrenceRaw);
  const preferRaw = readFlagValue(argv, '--prefer');
  const prefer = preferRaw === 'fidelity' || preferRaw === 'stability' ? preferRaw : undefined;
  const occurrence =
    parsedOccurrence !== undefined && Number.isInteger(parsedOccurrence) && parsedOccurrence > 0
      ? parsedOccurrence
      : undefined;
  return {
    slug: argv.find((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--occurrence' && argv[index - 1] !== '--prefer'),
    apply: argv.includes('--apply') && !dryRun,
    dryRun,
    ...(occurrence === undefined ? {} : { occurrence }),
    occurrenceProvided: argv.includes('--occurrence'),
    // Only surface the key when the flag is present, so the strict default
    // parse shape (and its exact-match tests) stay byte-identical.
    ...(argv.includes('--from-triage-verdict') ? { fromTriageVerdict: true } : {}),
    ...(prefer === undefined ? {} : { prefer }),
    ...(argv.includes('--prefer') ? { preferProvided: true } : {}),
    ...(argv.includes('--steal-state-lock') ? { stealStateLock: true } : {}),
    ...(argv.includes('--allow-privacy-disclosure') ? { allowPrivacyDisclosure: true } : {}),
    ...(argv.includes('--json') ? { json: true } : {}),
  };
}

/** `doctor`'s parsed flags — no positional (it probes the configured project as a whole, not one slug/session). */
export interface DoctorArgs {
  sinceHours?: number;
  json: boolean;
  stealScanLock?: boolean;
}

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  return {
    sinceHours: readNumberFlag(argv, '--since-hours'),
    json: argv.includes('--json'),
    ...(argv.includes('--steal-scan-lock') ? { stealScanLock: true } : {}),
  };
}

/** Parsed `--interval`/`--max-ticks` (both optional) alongside the shared `sessions` flags. */
export interface SessionsWatchArgs {
  interval?: string;
  maxTicks?: number;
}

export function parseSessionsWatchArgs(argv: string[]): SessionsWatchArgs {
  return {
    interval: readFlagValue(argv, '--interval'),
    maxTicks: readNumberFlag(argv, '--max-ticks'),
  };
}

/** `repro`'s parsed args: the required `<distinctId>` positional, optional exact session id, optional single-journey output override, and explicit overwrite flag — same shape as `PlanArgs`/`ScaffoldArgs`. The positional finder skips value-carrying repro flags so their values are never mistaken for the distinctId. Pure. */
export interface ReproArgs {
  distinctId?: string;
  session?: string;
  out?: string;
  force: boolean;
}

export function parseReproArgs(argv: string[]): ReproArgs {
  return {
    distinctId: argv.find((arg, i) => !arg.startsWith('--') && !isValueForReproFlag(argv, i)),
    session: readFlagValue(argv, '--session'),
    out: readFlagValue(argv, '--out'),
    force: argv.includes('--force'),
  };
}

function isValueForReproFlag(argv: string[], index: number): boolean {
  const previous = argv[index - 1];
  return previous === '--session' || previous === '--out';
}
