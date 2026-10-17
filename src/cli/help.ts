import { HARD_HEAL_VERDICT_AGE_DAYS } from '../heal-verdict-defaults.js';
import { renderCompletionEvidenceLadderCli } from '../completion-evidence.js';
import { DEFAULT_SAMPLED_REGISTER_SIZE } from '../sampled-register-defaults.js';
import { EXACT_SCAN_MAX_SESSIONS } from '../selection-scan-defaults.js';
import { CORE_SHAPE_NAMES } from '../shapes.js';
import { DEFAULT_SESSION_SCAN_HOURS } from '../session-scan-defaults.js';
import { DEFAULT_PLAN_SAMPLE, HEAL_PLAYWRIGHT_JSON_COMMAND, MAX_PLAN_SAMPLE, SCOPED_GAPS_SAMPLE_DEPTH_CEILING, TOOL_NAME } from './constants.js';

/** Every verb that has its own command handler (i.e. every `<verb>` a user can pass to the CLI besides the meta `help` command itself). Used to type the shared help table below and the per-verb `--help` shim. */
export type VerbName =
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
 * The SINGLE source of truth for every verb's usage line + flag list +
 * description — `buildHelpText()` (the full `help` listing) and
 * `buildVerbHelpText()` (a standalone `<verb> --help` synopsis) both render
 * from this table so the two surfaces can never drift apart. `lines[0]` is
 * always the `  ${TOOL_NAME} <verb> ...` usage line (flags inline in
 * brackets — that usage line IS the flag list); the remaining lines are the
 * indented prose description, verbatim from the pre-table help text.
 */
const VERB_HELP: ReadonlyArray<{ name: VerbName; lines: string[] }> = [
  {
    name: 'init',
    lines: [
      `  ${TOOL_NAME} init [--project <id>] [--token <key>] [--host <host>]`,
      '      Configure PostHog access (writes the repo-root .env), and ensure .env plus',
      '      .replaytest/ are gitignored: create a minimal .gitignore or append missing entries.',
      '      --host defaults to us.posthog.com; set it for EU Cloud (eu.posthog.com) or a self-hosted domain.',
    ],
  },
  {
    name: 'version',
    lines: [
      `  ${TOOL_NAME} version | --version | -v`,
      '      Print the installed replaytest package version.',
    ],
  },
  {
    name: 'sessions',
    lines: [
      `  ${TOOL_NAME} sessions [<sessionId> --from-archive <dir>] [--app <name>] [--completed] [--navigated] [--submitted] [--with-exceptions] [--shape <name>] [--families] [--gaps-only] [--stored] [--exact] [--json] [--replay-availability] [--fresh] [--since-hours N] [--limit N] [--all] [--page-size N] [--max-pages N] [--refresh-top N] [--steal-scan-lock] [--watch [--interval 15m|1h] [--max-ticks N]]`,
      `      List ranked canonical journeys from recent sessions (default last ${formatSessionScanWindow(DEFAULT_SESSION_SCAN_HOURS)}; override with --since-hours N).`,
      "      --with-exceptions filters to journeys whose session's events witnessed a JS",
      '      exception (exact scan only — coarse mode prints an honest one-liner and exits 0',
      '      with no rows rather than pretending).',
      `      --shape is repeatable and AND-composed: ${CORE_SHAPE_NAMES.join(', ')}. Shape-filtered`,
      "      output labels Seen directly, Strong hint, or Couldn't check; unavailable evidence is reported, never treated as no match.",
      '      Wizard URL overrides: add {"wizardStepParams":["step","phase"]} to',
      '      .replaytest/config.json. Names are case-insensitive; only ordinal values 1–99 match.',
      '      App scope: declare {"apps":{"shop":["https://shop.example"]},"app":"shop"} in',
      '      .replaytest/config.json, or use --app <name> to select a declared app for this scan.',
      '      --families: Families group paths that are segments of one longer recorded route (structural, not goal-based). Plans/tests stay per exact path. Path-based grouping for path-changing flows.',
      '      --gaps-only hides only exact rows whose lifecycle is Passing; coarse rows always stay visible.',
      '      --stored reads the dashboard\'s one stored snapshot without contacting PostHog; it refuses incompatible filters and names the stored key.',
      '      --exact is slower — it reads every session\'s events and bypasses the automatic coarse-scan switch. A forced --exact first states its whole-project session count (not a guessed duration). At the structural page ceiling it returns the exact rows read so far and names the covered sessions, pages, and window.',
      '      Coarse scans print an expected-case history estimate before work, report completed UTC days of history, name an up-to-date cache, and label every result with its scan mode.',
      '      --replay-availability adds a bounded live check to JSON replay links; unavailable can mean capture was off or the replay expired, while unknown is never absence.',
      '      --watch polls PostHog for new sessions on a cadence, printing one line per check and updating the same snapshot the dashboard reads (the next dashboard start picks it up for free; a dashboard already running keeps its in-memory view until restarted).',
      '      Defaults to the saved auto-check interval (15m/1h); --interval 15m|1h overrides it (15m is the floor). --max-ticks N runs a bounded number of checks. Foreground only — stopping the process (Ctrl-C) stops the checks. Cannot combine with --json or --stored.',
    ],
  },
  {
    name: 'gaps',
    lines: [
      `  ${TOOL_NAME} gaps [--app <name>] [--shape <name>]... [--refresh-sample] [--sample-size N] [--json] [--fresh] [--stored] [--exact] [--since-hours N] [--limit N] [--all] [--steal-scan-lock]`,
      '      Read the core traffic-signal link map. It ranks only rows with no known link in',
      '      this inventory; possible existing-suite matches and unavailable evidence stay in separate lanes.',
      `      --refresh-sample precomputes newest-session observations (default ${DEFAULT_SAMPLED_REGISTER_SIZE}; max ${EXACT_SCAN_MAX_SESSIONS}) without changing the core map. With --app it checks newest project sessions first, up to the fixed ${Math.min(SCOPED_GAPS_SAMPLE_DEPTH_CEILING, EXACT_SCAN_MAX_SESSIONS)}-candidate ceiling and the sample time budget, then reports the actual checked count.`,
      '      --exact is slower — it reads every session\'s events and bypasses the automatic coarse-scan switch. A forced --exact first states its whole-project session count (not a guessed duration). At the structural page ceiling it returns the exact rows read so far and names the covered sessions, pages, and window.',
      '      Coarse scans print an expected-case history estimate before work, report completed UTC days of history, name an up-to-date cache, and label every result with its scan mode.',
      '      --stored recomputes the map offline from the sealed coarse-store slices a prior live scan persisted — never contacts PostHog. It refuses (does not fall back to a live scan) when no stored scan covers this workspace, and loudly labels a partially-sealed snapshot. Cannot combine with --exact, --fresh, or --refresh-sample.',
    ],
  },
  {
    name: 'scan-status',
    lines: [
      `  ${TOOL_NAME} scan-status [--json]`,
      '      Reports your saved scan history. Makes no PostHog calls and starts no scan.',
      '      Reads manifest metadata plus local project configuration only; it never opens saved session rows.',
      '      Shows stored settled UTC-day coverage, first reads awaiting a second count-matching read,',
      '      and any recorded capped/interrupted gaps. The default view is 30 days; your scans may use',
      '      a different --since-hours window. --json keeps bounded ranges and gaps structured.',
    ],
  },
  {
    name: 'plan',
    lines: [
      `  ${TOOL_NAME} plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-cross-origin] [--allow-privacy-disclosure] [--steal-scan-lock]`,
      '      Fetch a session and write a reviewable sidecar (<slug>.md + <slug>.plan.json)',
      '      to .replaytest/plans/ for each plannable journey. Refuses to overwrite a',
      '      sidecar owned by a different or unknown journey unless --force is passed.',
      '      Plannable = every completed journey, plus a navigated one holding a single',
      '      inline-commit create (its spec presses the committing keystroke as a step',
      '      marked SYNTHESIZED, because no recording captures it).',
      // The live refusal already says the whole session is held back; the help
      // text used to stop at the single journey. Not false, just less complete —
      // and a reader planning a multi-journey session deserves to know the
      // blast radius before they run it, not after.
      '      Refuses a journey that spans origins or that witnessed no origin at all,',
      '      so a plan never asserts one property\'s URLs against another\'s — and',
      '      holds back every other plannable journey in the same session too, since',
      '      plan writes a session\'s journeys as one batch. Pass --allow-cross-origin',
      '      only after reviewing the other property, to release the whole run.',
      `      Samples up to ${DEFAULT_PLAN_SAMPLE} matching sessions by default for assertion evidence;`,
      `      pass --sample 0 to disable, or --sample N (max ${MAX_PLAN_SAMPLE}) to tune it.`,
      `      Archive mode: ${TOOL_NAME} plan <sessionId> --from-archive <dir>`,
    ],
  },
  {
    name: 'scaffold',
    lines: [
      `  ${TOOL_NAME} scaffold <slug> [--force] [--out <path>] [--steal-state-lock]`,
      '      Generate tests/generated/<slug>.spec.ts (and re-render <slug>.md) from an',
      '      already-written sidecar. Refuses to overwrite an existing spec: pass --force',
      '      to overwrite it, or --out <path> to write a new file you diff yourself.',
    ],
  },
  {
    name: 'frames',
    lines: [
      `  ${TOOL_NAME} frames <slug> [--from-archive <dir>] [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]`,
      '      Create local per-step replay DOM and screenshots for a coding agent. Frames',
      '      contain real historical user content: keep them local and never commit/share them.',
    ],
  },
  {
    name: 'repro',
    lines: [
      `  ${TOOL_NAME} repro <distinctId> [--session <sessionId>] [--out <path>] [--force]`,
      '      Emit a Tier-0 reproduction spec (tests/reproductions/<slug>.repro.spec.ts) for',
      '      EVERY journey in the session, any status (error/abandoned included) — re-driving',
      '      the recorded steps IS the smoke; no assertions are active. Notes witnessed',
      '      exceptions in a header comment. Refuses to overwrite an existing file unless',
      '      --force; --out <path> writes elsewhere (single-journey sessions only).',
    ],
  },
  {
    name: 'preflight',
    lines: [
      `  ${TOOL_NAME} preflight <slug> [--json]`,
      '      Check the LOCAL plan\'s recorded locators against the LIVE APP at TARGET_APP_URL',
      '      (default http://localhost:8000; warns when that fallback is used). Never calls',
      '      PostHog or runs the full spec: reports resolves, DEAD, gated-unreachable after a',
      '      recorded submit, or couldn\'t check when direct goto cannot reach a page.',
      '      Exits 1 when it finds dead selectors or verifies no selectors; otherwise each row states',
      '      what was checked.',
      '      Triage fresh traffic to learn what a dead locator became — preflight complements,',
      '      never replaces, triage.',
    ],
  },
  {
    name: 'triage',
    lines: [
      `  ${TOOL_NAME} triage <slug> [--sample N] [--since-hours N] [--app <name>] [--propose] [--force] [--json] [--steal-state-lock] [--steal-scan-lock] [--reuse-evidence [--max-age <duration>]]`,
      '      Explain why a generated test may now be failing by checking fresh traffic for',
      '      the sidecar signature. Never changes your journey definition; healthy live checks',
      '      record only their own evidence trail in the plan sidecar (disclosed on the first write).',
      '      Proposals go only to .replaytest/plans/<slug>.proposed.plan.json + <slug>.proposed.md.',
      '      --app <name> confines the evidence to one app declared in .replaytest/config.json,',
      '      so a verdict is never derived from another site\'s traffic; sessions set aside are',
      '      disclosed, never silently dropped.',
    ],
  },
  {
    name: 'regenerate',
    lines: [
      `  ${TOOL_NAME} regenerate <slug> [--since-hours N] [--app <name>] [--allow-cross-origin] [--json] [--steal-scan-lock]`,
      '      Re-source a stale plan from fresh traffic into the existing proposal slot. It tries',
      '      the same journey first, then a disclosed successor flow; review diff and apply the',
      '      spec delta yourself — replaytest never merges a generated spec. Refuses candidates',
      '      from another origin, spanning origins, or lacking a witnessed origin unless --allow-cross-origin is reviewed.',
      '      When it finds no candidate, its empty live search records only an evidence trail in the plan',
      '      sidecar (disclosed on the first write), never your journey definition.',
    ],
  },
  {
    name: 'diff',
    lines: [
      `  ${TOOL_NAME} diff <slug> [--json]`,
      '      Re-render the proposed plan sidecar against the current live plan without changing either file.',
      '      --json emits the same structured change object the propose/regenerate envelopes carry,',
      '      so a coding agent reads the delta without parsing the rendered Markdown.',
    ],
  },
  {
    name: 'doctor',
    lines: [
      `  ${TOOL_NAME} doctor [--since-hours N] [--json] [--steal-scan-lock]`,
      '      Read-only provider-capability preflight: 7 independent probes report what',
      '      this project can feed plan/scaffold (events flowing, autocapture richness,',
      '      recordings, Tier-3 replay DOM) plus your local Playwright/posthog-cli',
      '      version fit, and what degrades if a probe is weak. Never writes to PostHog;',
      '      maintains a local cache under .replaytest/cache/ and exits 0 whenever PostHog is configured.',
    ],
  },
  {
    name: 'heal',
    lines: [
      `  ${TOOL_NAME} heal [--results <path>] [--since-hours N] [--sample N] [--app <name>] [--propose] [--force] [--allow-stale] [--json] [--steal-state-lock] [--steal-scan-lock]`,
      '      Batch-triage every genuinely-failed spec from a Playwright JSON-reporter run',
      '      (default .replaytest/last-run.json — produce it with this Playwright command:',
      `      \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`, then`,
      `      run '${TOOL_NAME} heal' as a separate step). Classifies failure MODE first —`,
      '      flaky/timed-out/interrupted/environment-network specs get no traffic verdict —',
      '      maps each real',
      '      failure back to its plan (a slug header, else the tests/generated/ path',
      '      convention), then runs the same evidence-based check as `triage` for each one,',
      '      sharing ONE traffic scan across the whole batch. A verdict that looks clean on',
      '      a spec Playwright actually failed is flagged, never hidden. --propose writes',
      '      flow-changed proposals + a rendered plan-diff, same as `triage --propose`. Runs older',
      `      than ${HARD_HEAL_VERDICT_AGE_DAYS} days require --allow-stale; re-run the Playwright command above for current evidence.`,
      '      --app <name> confines every slug\'s evidence to one app declared in',
      '      .replaytest/config.json; the batch still shares ONE traffic scan.',
    ],
  },
  {
    name: 'accept',
    lines: [
      `  ${TOOL_NAME} accept <slug> [--force] [--confirm-different-journey] [--json] [--steal-state-lock]`,
      '      Promote .replaytest/plans/<slug>.proposed.plan.json to the live',
      '      <slug>.plan.json, refresh <slug>.md from that JSON, and retire the',
      '      consumed proposal artifacts. Refuses an existing live plan unless --force.',
      '      A different journey needs --confirm-different-journey too; a same-signature',
      '      regenerate proposal is treated as the same journey, so --force alone promotes it.',
      `      Does not re-scaffold; on success prints the next command: ${TOOL_NAME} scaffold <slug> --force.`,
    ],
  },
  {
    name: 'retire',
    lines: [
      `  ${TOOL_NAME} retire <slug> [--confirm-retire] [--no-evidence] [--steal-lock] [--steal-state-lock] [--recover-crashed-locks] [--allow-privacy-disclosure] [--json]`,
      '      Review the accumulated empty-search evidence for a journey and, once the',
      '      evidence bar is met, archive its plan/spec/frames/default-path repro into',
      '      .replaytest/retired/<slug>/ with a reversal recipe. Read-only by default:',
      '      no flag presents the trail, the bar status, successor observations, and the',
      '      consent command. --confirm-retire performs the archival (bar must be met).',
      '      --confirm-retire --no-evidence retires below the bar on operator assertion',
      '      (the tool records the assertion, never adopts it). Each flag alone refuses.',
      '      Keep the archive folder local to preserve the record; see retirement.json to reverse.',
      '      An interrupted retirement resumes only with --confirm-retire. After a crash,',
      '      --recover-crashed-locks performs the combined recovery only when BOTH lock owners',
      '      are dead. Use either --recover-crashed-locks or the explicit steal flags, not both.',
      '      Granular form: --confirm-retire --steal-lock --steal-state-lock.',
      '      All shared state writers serialize through one cross-verb state lock; --steal-state-lock',
      '      may allow one live holder write to land over recent state. Retire still acquires',
      '      its retire lock first, then the shared state lock; the reverse order is forbidden.',
    ],
  },
  {
    name: 'suite-status',
    lines: [
      `  ${TOOL_NAME} suite-status [--since-hours N] [--app <name>] [--json]`,
      '      Reverse pass over every plan: is each one\'s journey still present in recent',
      '      traffic at all? Flags DEAD coverage (no matching traffic — never phrased as',
      '      "delete this test", traffic can be seasonal) separately from UNRESOLVABLE',
      '      plans (no recorded signature — never counted as dead) and from plans that are',
      '      not yet scaffolded. Read-only; shares one traffic scan across every plan.',
      '      --app <name> counts coverage only inside one app declared in .replaytest/config.json,',
      '      so another site\'s traffic can neither create nor hide a dead-coverage finding.',
      '      Differs from suite-health: this is plan-inventory freshness; suite-health diagnoses last test runs plus coverage per generated spec.',
    ],
  },
  {
    name: 'suite-health',
    lines: [
      `  ${TOOL_NAME} suite-health [--app <name>] [--json]`,
      '      Join local generated specs, plans, and the last heal run with a fresh shared',
      '      suite-status coverage scan. Shows recorded evidence only: an empty workspace or',
      '      absent heal run is never inferred to be green.',
      '      --app <name> is passed straight through to that shared coverage pass.',
      '      Differs from suite-status: this is per-generated-spec health; suite-status is the plan-inventory freshness reverse check.',
    ],
  },
  {
    name: 'reconcile',
    lines: [
      `  ${TOOL_NAME} reconcile [--apply] [--dry-run]`,
      '      Report sidecars superseded by a newer plan batch for the same recorded session.',
      '      Default and --dry-run only report; --apply renames sidecars to .superseded.*.',
    ],
  },
  {
    name: 'fix-selector',
    lines: [
      `  ${TOOL_NAME} fix-selector <slug> [--apply] [--dry-run] [--occurrence N] [--prefer stability|fidelity] [--from-triage-verdict] [--allow-privacy-disclosure] [--json] [--steal-state-lock]`,
      '      Show the newest persisted triage or heal selector patch by default. --apply replaces',
      '      exactly one emitted occurrence; when several match, choose one with --occurrence N.',
      '      --from-triage-verdict tolerates a prior hand-edit: it applies the diagnosed verdict',
      '      even when the old locator string is gone, and reports "already applied" if the spec',
      '      already holds the fresh locator (never overwrites a hand-edit silently).',
      '      --prefer fidelity is the default; --prefer stability selects a recorded alternate',
      '      only when the latest fresh traffic also verified it.',
    ],
  },
  {
    name: 'auth-setup',
    lines: [
      `  ${TOOL_NAME} auth-setup [--allow-privacy-disclosure]`,
      '      Read persisted plan sidecars that witnessed a login, write one shared',
      '      playwright/auth.setup.ts skeleton, and print an insertable config snippet.',
      '      It never edits your Playwright config, never stores credentials, and refuses',
      '      to overwrite an existing auth.setup.ts. The v1 interface is human-readable;',
      '      --json is intentionally not supported.',
    ],
  },
  {
    name: 'dashboard',
    lines: [
      `  ${TOOL_NAME} dashboard`,
      '      Start the local dashboard (a browser GUI over these same commands) on',
      '      http://127.0.0.1:4319 — override the port with PORT. Reads/writes the repo',
      '      you run it from, same as every other command.',
    ],
  },
  {
    name: 'explain',
    lines: [
      `  ${TOOL_NAME} explain [<refusal-code>] [--list] [--full] [--json]`,
      '      Explain a known refusal code without reading workspace data or contacting PostHog.',
      '      Re-run the command that refused with --json and use error.code,',
      '      then run replaytest explain <verb.code>. For example, a regenerate.origin-unrecorded',
      '      refusal means no site address could be resolved; use --list to discover codes.',
      '      The message field is the exact refusal message template; {{…}} marks parts filled in',
      '      when the command runs — with a value, a context-dependent phrase, or nothing at all.',
      '      --list prints a compact grouped list; --full requires --list and includes each entry\'s detail.',
    ],
  },
];

function verbHelpEntry(verb: VerbName): { name: VerbName; lines: string[] } {
  const entry = VERB_HELP.find((candidate) => candidate.name === verb);
  if (entry === undefined) throw new Error(`No help entry registered for verb "${verb}" — this is a VERB_HELP table bug, not a user error.`);
  return entry;
}

/** Narrows an arbitrary router token to the canonical help-table verb roster. */
export function isVerbName(value: string | undefined): value is VerbName {
  return value !== undefined && VERB_HELP.some((entry) => entry.name === value);
}

/** True only for verbs whose canonical synopsis advertises `--json`. */
export function verbSupportsJson(verb: VerbName): boolean {
  return verbHelpEntry(verb).lines[0]?.includes('[--json]') === true;
}

/** Flags a parser deliberately recognizes so it can preserve its own refusal copy instead of the generic unknown-flag copy. */
export const RECOGNIZED_UNSUPPORTED_FLAGS: Partial<Record<VerbName, readonly string[]>> = {
  'auth-setup': ['--json'],
};

/** Finds the first unknown long flag from the canonical synopsis's flag set. */
export function findUnknownVerbFlag(argv: readonly string[], verb: VerbName): string | undefined {
  const usageLine = verbHelpEntry(verb).lines[0] ?? '';
  const knownFlags = new Set(usageLine.match(/--[a-z][a-z-]*/g) ?? []);
  for (const flag of RECOGNIZED_UNSUPPORTED_FLAGS[verb] ?? []) knownFlags.add(flag);
  knownFlags.add('--help');
  return argv.find((arg) => arg.startsWith('--') && !knownFlags.has(arg));
}

/** The canonical one-line synopsis for usage-error branches. */
export function buildVerbUsageLine(verb: VerbName): string {
  const line = verbHelpEntry(verb).lines[0];
  if (line === undefined) throw new Error(`No usage line registered for verb "${verb}" — this is a VERB_HELP table bug, not a user error.`);
  return `Usage: ${line.trimStart()}`;
}

/** The full usage text `help` prints, and what a no-arg or unrecognized invocation falls back to. Pure string-builder — no I/O. */
export function buildHelpText(): string {
  return [
    `${TOOL_NAME} — turn real PostHog sessions into Playwright regression tests`,
    '',
    'Usage:',
    ...VERB_HELP.flatMap((entry) => entry.lines),
    `  ${TOOL_NAME} help`,
    '      Show this message.',
    '',
    renderCompletionEvidenceLadderCli(),
    '',
    'First touch: `replaytest init` → `replaytest sessions` → `replaytest plan <distinctId>` → `replaytest scaffold <slug>` → run the generated test. Use `replaytest doctor` only when something is wrong; use `replaytest preflight <slug>` before a real run. Neither is a first-touch step. For a red test, read AGENT-MAINTENANCE-GUIDE.md (shipped with replaytest).',
  ].join('\n');
}

/**
 * A standalone `<verb> --help` / `<verb> -h` synopsis: the same usage line +
 * flag list + description `buildHelpText()` renders for this verb, rendered
 * on its own so it reads correctly outside the full command list. Pure
 * string-builder — no I/O. See `maybePrintVerbHelp` for where this actually
 * short-circuits a command.
 */
export function buildVerbHelpText(verb: VerbName): string {
  return ['Usage:', ...verbHelpEntry(verb).lines].join('\n');
}

/** `true` when `argv` explicitly asked for help (`--help` or `-h`), anywhere in the verb's own args. */
function wantsVerbHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * The per-verb `--help`/`-h` shim: checked as the FIRST statement in every
 * verb handler, before any arg parsing, config/workspace read, provider
 * call, or server start — so `<verb> --help` can never fall through to a
 * required-positional usage error (arg-required verbs) and can never
 * execute the real command for real (flag-only verbs). Prints the verb's
 * synopsis via `log` (defaults to `console.log`, matching every handler's
 * own default) and returns `true` when it fired; callers `return` on
 * `true`. Pure with respect to program state other than that print.
 */
export function maybePrintVerbHelp(argv: string[], verb: VerbName, log: (line: string) => void = (line) => console.log(line)): boolean {
  if (!wantsVerbHelp(argv)) return false;
  log(buildVerbHelpText(verb));
  return true;
}

export function formatSessionScanWindow(sinceHours: number): string {
  if (sinceHours < 24) return `${sinceHours}h`;

  const days = sinceHours / 24;
  const roundedDays = Number.isInteger(days) ? String(days) : String(Number(days.toFixed(2)));
  const noun = roundedDays === '1' ? 'day' : 'days';
  return `${sinceHours}h (${roundedDays} ${noun})`;
}
