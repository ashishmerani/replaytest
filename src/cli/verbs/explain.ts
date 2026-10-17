/**
 * `replaytest explain [<refusal-code>] [--list] [--full] [--json]`.
 *
 * This is a local catalog lookup. It deliberately reads neither workspace
 * state nor network state: an agent can inspect a refusal even when the
 * command that produced it could not proceed.
 */

import {
  findRefusalEntries,
  listedRefusalEntries,
  namespacedRefusalCode,
  refusalCoverage,
  type RefusalRegistryEntryValue,
  type RefusalTier,
} from '../../refusal-registry.js';
import { refuseUnknownFlag, usageErrorEnvelope } from '../args.js';
import { maybePrintVerbHelp } from '../help.js';

export const EXPLAIN_SCHEMA_VERSION = 1;
export const MAX_EXPLAIN_CODE_LENGTH = 160;
/** Explains the registry's literal interpolation markers on human output only. */
export const EXPLAIN_TEMPLATE_LEGEND = 'Note: Parts shown as {{…}} are filled in when the command runs — with a value, a context-dependent phrase, or nothing at all.';

const EXPLAIN_USAGE = 'Usage: replaytest explain [<refusal-code>] [--list] [--full] [--json]';

export interface ExplainRunDeps {
  log?: (line: string) => void;
}

interface ExplainArgs {
  code?: string;
  json: boolean;
  list: boolean;
  full: boolean;
  error?: string;
}

interface ExplainCoverage {
  explained: number;
  recognized: number;
  total: number;
}

interface ExplainResolvedEnvelope {
  schemaVersion: typeof EXPLAIN_SCHEMA_VERSION;
  kind: 'resolved';
  code: string;
  nsCode: string;
  verb: string;
  contentStatus: string;
  message: string;
  meaning: string;
  evidenceClass: string;
  jsonVisible: boolean;
  exitCode: number;
  tier: string;
  cases: readonly { description: string; message: string; exitCode: number }[];
  override: { flags: readonly string[]; consentSemantics: string; preconditions: readonly string[] } | null;
  nextSteps: readonly { description: string; command?: string }[];
  coverage: ExplainCoverage;
}

type ExplainResolvedEntry = Omit<ExplainResolvedEnvelope, 'coverage'>;

const CUSTOMER_FACING_TIER: Readonly<Record<RefusalTier, string>> = {
  A: 'shown with a code',
  B: 'has a code that is not shown',
  C: 'does not have a code',
  internal: 'is an internal invariant report, not a customer recovery option',
};

function parseExplainArgs(argv: string[]): ExplainArgs {
  const positionals = argv.filter((arg) => !arg.startsWith('--'));
  if (positionals.length > 1) return { json: argv.includes('--json'), list: argv.includes('--list'), full: argv.includes('--full'), error: EXPLAIN_USAGE };
  const code = positionals[0];
  const list = argv.includes('--list');
  if (list && code !== undefined) return { json: argv.includes('--json'), list, full: argv.includes('--full'), error: `Use either a refusal code or --list. ${EXPLAIN_USAGE}` };
  if (!list && argv.includes('--full')) return { json: argv.includes('--json'), list, full: true, error: `--full requires --list. ${EXPLAIN_USAGE}` };
  if (code !== undefined && code.length > MAX_EXPLAIN_CODE_LENGTH) {
    return { json: argv.includes('--json'), list, full: argv.includes('--full'), error: `Refusal codes may be at most ${MAX_EXPLAIN_CODE_LENGTH} characters. ${EXPLAIN_USAGE}` };
  }
  return { ...(code === undefined ? {} : { code }), json: argv.includes('--json'), list, full: argv.includes('--full') };
}

function coverage(): ExplainCoverage {
  return refusalCoverage();
}

function effectiveCaseExitCode(situation: { description: string; exitCode?: number }, fallback: number): number {
  return situation.exitCode ?? fallback;
}

function resolvedExplainEntry(entry: RefusalRegistryEntryValue): ExplainResolvedEntry {
  return {
    schemaVersion: EXPLAIN_SCHEMA_VERSION,
    kind: 'resolved',
    code: entry.code,
    nsCode: namespacedRefusalCode(entry),
    verb: entry.verb,
    contentStatus: entry.contentStatus,
    message: entry.message,
    meaning: entry.meaning,
    evidenceClass: entry.evidenceClass,
    jsonVisible: entry.jsonVisible,
    exitCode: entry.exitCode,
    tier: CUSTOMER_FACING_TIER[entry.tier],
    cases: entry.cases.map((situation) => ({
      description: situation.description,
      message: situation.message,
      exitCode: effectiveCaseExitCode(situation, entry.exitCode),
    })),
    override: entry.override,
    nextSteps: entry.nextSteps,
  };
}

export function resolvedExplainEnvelope(entry: RefusalRegistryEntryValue): ExplainResolvedEnvelope {
  return { ...resolvedExplainEntry(entry), coverage: coverage() };
}

function listExplainEnvelope(full: boolean): object {
  const entries = listedRefusalEntries();
  return {
    schemaVersion: EXPLAIN_SCHEMA_VERSION,
    kind: 'list',
    coverage: coverage(),
    entries: full
      ? entries.map((entry) => resolvedExplainEntry(entry))
      : entries.map((entry) => ({ nsCode: namespacedRefusalCode(entry), contentStatus: entry.contentStatus })),
  };
}

function editDistance(left: string, right: string): number {
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (prior[rightIndex] ?? 0) + 1,
        (prior[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index < current.length; index += 1) prior[index] = current[index] ?? 0;
  }
  return prior[right.length] ?? 0;
}

function suggestionsFor(input: string): string[] {
  return listedRefusalEntries()
    .map((entry) => namespacedRefusalCode(entry))
    .sort((left, right) => editDistance(input, left) - editDistance(input, right) || left.localeCompare(right))
    .slice(0, 3);
}

function unknownExplainEnvelope(input: string): object {
  const entry = findRefusalEntries('explain.unknown-code')[0];
  if (entry === undefined) throw new Error('explain.unknown-code must stay registered.');
  return {
    schemaVersion: EXPLAIN_SCHEMA_VERSION,
    kind: 'unknown-code',
    error: {
      code: 'unknown-code',
      nsCode: namespacedRefusalCode(entry),
      message: `No recognized refusal code matches "${input}".`,
    },
    suggestions: suggestionsFor(input),
    coverage: coverage(),
  };
}

function ambiguousExplainEnvelope(input: string, candidates: readonly RefusalRegistryEntryValue[]): object {
  const entry = findRefusalEntries('explain.ambiguous-code')[0];
  if (entry === undefined) throw new Error('explain.ambiguous-code must stay registered.');
  return {
    schemaVersion: EXPLAIN_SCHEMA_VERSION,
    kind: 'ambiguous-code',
    error: {
      code: 'ambiguous-code',
      nsCode: namespacedRefusalCode(entry),
      message: `More than one recognized refusal code matches "${input}".`,
    },
    candidates: candidates.map((candidate) => namespacedRefusalCode(candidate)).sort(),
    coverage: coverage(),
  };
}

/** Complete harmless samples for docs-field inventory and contract tests. */
export function explainJsonFixtureEnvelopes(): readonly object[] {
  const resolved = findRefusalEntries('regenerate.origin-unrecorded')[0];
  const ambiguous = findRefusalEntries('unconfigured');
  if (resolved === undefined || ambiguous.length < 2) throw new Error('Explain fixtures require a known refusal code and an ambiguous lookup.');
  return [
    resolvedExplainEnvelope(resolved),
    listExplainEnvelope(false),
    unknownExplainEnvelope('not-a-code'),
    ambiguousExplainEnvelope('unconfigured', ambiguous),
    usageErrorEnvelope(`--full requires --list. ${EXPLAIN_USAGE}`),
  ];
}

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type RoleOutcomeEntry = {
  exitCode: number;
  cases: readonly object[];
};

export function hasRoleDependentOutcome(entry: RoleOutcomeEntry): boolean {
  return new Set(entry.cases.map((situation) =>
    'exitCode' in situation && typeof situation.exitCode === 'number' ? situation.exitCode : entry.exitCode,
  )).size > 1;
}

function renderEntryHeading(entry: RefusalRegistryEntryValue): string {
  return `${hasRoleDependentOutcome(entry) ? entry.code : namespacedRefusalCode(entry)} — ${entry.meaning}`;
}

function renderEntryExitCode(entry: RefusalRegistryEntryValue): string {
  return hasRoleDependentOutcome(entry)
    ? 'Exit code: 1 for the refusing role; continues (exit 0) for the warning role.'
    : `Exit code: ${entry.exitCode}.`;
}

function renderEntry(entry: RefusalRegistryEntryValue): string {
  const lines = [
    renderEntryHeading(entry),
    `Message: ${entry.message}`,
    ...(entry.message.includes('{{') ? [EXPLAIN_TEMPLATE_LEGEND] : []),
    `Code visibility: ${entry.jsonVisible ? 'shown in this command\'s --json refusal output' : 'not shown in this command\'s --json refusal output'}.`,
    renderEntryExitCode(entry),
  ];
  if (entry.contentStatus === 'message-only' && !entry.meaning.toLowerCase().includes('this code has no detailed explanation')) {
    lines.push('This code has no detailed explanation. The message above is the full description.');
  }
  if (entry.cases.length > 1) {
    lines.push('Situations:');
    for (const situation of entry.cases) lines.push(`- ${situation.description}`);
  }
  if (entry.override !== null) {
    lines.push(`Override: ${entry.override.flags.join(' ')} — ${entry.override.consentSemantics}`);
    for (const precondition of entry.override.preconditions) lines.push(`Before using it: ${precondition}`);
  }
  if (entry.nextSteps.length > 0) {
    lines.push('Next steps:');
    for (const nextStep of entry.nextSteps) {
      const command = 'command' in nextStep ? nextStep.command : undefined;
      lines.push(`- ${nextStep.description}${command === undefined ? '' : ` Run: \`${command}\`.`}`);
    }
  }
  return lines.join('\n');
}

function renderList(full: boolean): string {
  const lines = [
    'This command reads the local refusal catalog only. It never reads your workspace or contacts PostHog.',
  ];
  let currentVerb: string | undefined;
  for (const entry of listedRefusalEntries()) {
    if (entry.verb !== currentVerb) {
      currentVerb = entry.verb;
      lines.push('', `${currentVerb}:`);
    }
    if (full) lines.push(renderEntry(entry));
    else lines.push(`- ${namespacedRefusalCode(entry)}${entry.contentStatus === 'message-only' ? ' (message only — no detailed explanation)' : ''}`);
  }
  return lines.join('\n');
}

/** Local command handler; no workspace or network dependencies are accepted. */
export function runExplain(argv: string[], deps: ExplainRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'explain', deps.log)) return;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (refuseUnknownFlag('explain', argv, { log })) return;
  const args = parseExplainArgs(argv);
  if (args.error !== undefined) {
    log(args.json ? json(usageErrorEnvelope(args.error)).trimEnd() : args.error);
    process.exitCode = 1;
    return;
  }

  if (args.code === undefined) {
    const output = args.json ? json(listExplainEnvelope(args.full)).trimEnd() : renderList(args.full);
    log(output);
    return;
  }

  const entries = findRefusalEntries(args.code);
  if (entries.length === 0) {
    const output = args.json ? json(unknownExplainEnvelope(args.code)).trimEnd() : `No recognized refusal code matches "${args.code}". Try: ${suggestionsFor(args.code).join(', ')}.`;
    log(output);
    process.exitCode = 1;
    return;
  }
  if (entries.length > 1) {
    const candidates = entries.map((entry) => namespacedRefusalCode(entry)).sort();
    const output = args.json ? json(ambiguousExplainEnvelope(args.code, entries)).trimEnd() : `More than one recognized refusal code matches "${args.code}": ${candidates.join(', ')}.`;
    log(output);
    process.exitCode = 1;
    return;
  }

  const entry = entries[0];
  if (entry === undefined) throw new Error('A non-empty explain lookup must have one entry.');
  log(args.json ? json(resolvedExplainEnvelope(entry)).trimEnd() : renderEntry(entry));
}
