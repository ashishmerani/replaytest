/**
 * Completion-visibility guard. This deliberately derives its verb census from
 * CLI_VERBS, the router-drift-checked canonical roster, rather than keeping a
 * fourth hand-maintained command list. Every non-blocking handler gets an
 * injected stdout collector and must render a non-empty refusal/no-op outcome.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { CLI_VERBS, type CliVerb } from './artifact-registry.js';
import { runExplain as runExplainFromCompat, runRetire as runRetireFromCompat } from './cli.js';
import { buildUnknownFlagUsageError, buildUsageError, refuseUnknownFlag } from './cli/args.js';
import { buildVerbUsageLine, RECOGNIZED_UNSUPPORTED_FLAGS, verbSupportsJson } from './cli/help.js';
import { runAccept } from './cli/verbs/accept.js';
import { runDiff } from './cli/verbs/diff.js';
import { runDoctor } from './cli/verbs/doctor.js';
import { runFixSelector } from './cli/verbs/fix-selector.js';
import { runFramesCommand } from './cli/verbs/frames.js';
import { runGaps } from './cli/verbs/gaps.js';
import { runScanStatus } from './cli/verbs/scan-status.js';
import { runHeal } from './cli/verbs/heal.js';
import { runInit } from './cli/verbs/init.js';
import { runPlan } from './cli/verbs/plan.js';
import { runPreflight } from './cli/verbs/preflight.js';
import { runReconcile } from './cli/verbs/reconcile.js';
import { runRetire } from './cli/verbs/retire.js';
import { runRegenerate } from './cli/verbs/regenerate.js';
import { runRepro } from './cli/verbs/repro.js';
import { runScaffold } from './cli/verbs/scaffold.js';
import { runSessions } from './cli/verbs/sessions.js';
import { runSuiteHealth } from './cli/verbs/suite-health.js';
import { runSuiteStatus } from './cli/verbs/suite-status.js';
import { runTriage } from './cli/verbs/triage.js';
import { runVersion } from './cli/verbs/version.js';
import { runAuthSetup } from './cli/verbs/auth-setup.js';
import { runExplain } from './cli/verbs/explain.js';
import { neutralSessionFromSteps, orderConfirmationSteps, runCliInFixture } from './cli/verbs/test-support.js';
import { fetchAllSessions } from './providers/posthog-adapter.js';

type OutcomeRunner = (log: (line: string) => void) => void | Promise<void>;

const unconfigured = () => ({ projectId: undefined, hasApiKey: false });
const defaultWizardConfig = () => ({ paramNames: [], overridesActive: false });

const JSON_VERBS = CLI_VERBS.filter(verbSupportsJson);

function requiredPositionals(verb: CliVerb): string[] {
  const tokens = buildVerbUsageLine(verb).match(/\[|\]|<[^>]+>|[^\s\[\]]+/g) ?? [];
  let bracketDepth = 0;
  const positionals: string[] = [];
  for (const token of tokens) {
    if (token === '[') {
      bracketDepth += 1;
      continue;
    }
    if (token === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (bracketDepth === 0 && token.startsWith('<') && token.endsWith('>')) positionals.push(`fixture-${token.slice(1, -1)}`);
  }
  return positionals;
}

function unknownFlagArgs(verb: CliVerb, json: boolean): string[] {
  return [verb, ...requiredPositionals(verb), ...(json ? ['--json'] : []), '--bogus-flag'];
}

function captureUnknownFlag(argv: readonly string[]): { refused: boolean; output: string[]; exitCode: number | undefined } {
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  try {
    process.exitCode = undefined;
    const [command, ...rest] = argv;
    const refused = refuseUnknownFlag(command, rest, { log: (line) => output.push(line) });
    return { refused, output, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

type RealCliUsageCase = {
  name: string;
  argv: readonly string[];
  exitCode: 1;
};

const JSON_VALIDATION_CASES: readonly RealCliUsageCase[] = [
  { name: 'accept missing slug', argv: ['accept', '--json'], exitCode: 1 },
  { name: 'diff missing slug', argv: ['diff', '--json'], exitCode: 1 },
  { name: 'gaps conflicting output caps', argv: ['gaps', '--json', '--all', '--limit', '3'], exitCode: 1 },
  { name: 'gaps invalid shape', argv: ['gaps', '--json', '--shape', 'bogusshape'], exitCode: 1 },
  { name: 'preflight missing slug', argv: ['preflight', '--json'], exitCode: 1 },
  { name: 'regenerate missing slug', argv: ['regenerate', '--json'], exitCode: 1 },
  { name: 'retire missing slug', argv: ['retire', '--json'], exitCode: 1 },
  { name: 'retire conflicting recovery flags', argv: ['retire', 'fixture-slug', '--json', '--recover-crashed-locks', '--steal-lock'], exitCode: 1 },
  { name: 'sessions non-positive limit', argv: ['sessions', '--json', '--limit', '0'], exitCode: 1 },
  { name: 'sessions conflicting output caps', argv: ['sessions', '--json', '--all', '--limit', '3'], exitCode: 1 },
  { name: 'sessions invalid shape', argv: ['sessions', '--json', '--shape', 'bogusshape'], exitCode: 1 },
  { name: 'sessions archive without session id', argv: ['sessions', '--json', '--from-archive', os.tmpdir()], exitCode: 1 },
  { name: 'triage missing slug', argv: ['triage', '--json'], exitCode: 1 },
  { name: 'sessions watch rejects JSON streaming', argv: ['sessions', '--watch', '--json'], exitCode: 1 },
  { name: 'explain full without list', argv: ['explain', '--full', '--json'], exitCode: 1 },
] as const;

function assertRealCliUsageEnvelope(usageCase: RealCliUsageCase): void {
  const result = runCliInFixture(process.cwd(), [...usageCase.argv]);
  assert.equal(result.status, usageCase.exitCode, `${usageCase.name} must exit ${usageCase.exitCode}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '', `${usageCase.name} must not add prose on stderr`);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; message: string } };
  assert.deepEqual(Object.keys(envelope), ['error'], `${usageCase.name} must write one top-level error envelope`);
  assert.deepEqual(Object.keys(envelope.error), ['code', 'message'], `${usageCase.name} must keep the shared error shape`);
  assert.equal(envelope.error.code, 'usage-error', `${usageCase.name} must carry the usage-error code`);
  assert.ok(envelope.error.message.length > 0, `${usageCase.name} must preserve its specific refusal message`);
  assert.equal(result.stdout, `${JSON.stringify(envelope, null, 2)}\n`, `${usageCase.name} stdout must be exactly one JSON envelope`);
}

const DELIVERY_WORKSPACE = path.join(process.cwd(), 'tmp', '455-probe');

function realCliDeliveryWorkspace(): string {
  fs.mkdirSync(DELIVERY_WORKSPACE, { recursive: true });
  return DELIVERY_WORKSPACE;
}

function firstOutputLine(output: string): string {
  return output.split('\n')[0] ?? '';
}

type RealCliUnknownFlagDeliveryCase = {
  name: string;
  argv: readonly string[];
  allowsStderr?: true;
  assertResult: (result: ReturnType<typeof runCliInFixture>) => void;
};

const REAL_CLI_UNKNOWN_FLAG_DELIVERY_CASES: readonly RealCliUnknownFlagDeliveryCase[] = [
  {
    name: 'sessions --bogusflag',
    argv: ['sessions', '--bogusflag'],
    assertResult: (result) => {
      assert.equal(result.status, 1);
      assert.equal(firstOutputLine(result.stdout), 'Unknown flag: --bogusflag.');
    },
  },
  {
    name: 'sessions --json --bogusflag',
    argv: ['sessions', '--json', '--bogusflag'],
    assertResult: (result) => {
      assert.equal(result.status, 1);
      const envelope = JSON.parse(result.stdout) as { error: { code: string; message: string } };
      assert.deepEqual(envelope.error, { code: 'usage-error', message: buildUnknownFlagUsageError('sessions', '--bogusflag') });
    },
  },
  {
    name: 'explain --bogusflag',
    argv: ['explain', '--bogusflag'],
    assertResult: (result) => {
      assert.equal(result.status, 1);
      assert.equal(firstOutputLine(result.stdout), 'Unknown flag: --bogusflag.');
    },
  },
  {
    name: 'auth-setup --json',
    argv: ['auth-setup', '--json'],
    assertResult: (result) => {
      assert.equal(result.status, 1);
      assert.equal(firstOutputLine(result.stdout), 'auth-setup does not support --json in v1; read the skeleton, who-needs-it table, and printed config snippet instead.');
    },
  },
  {
    name: 'plan someid --from-archive <missing>',
    argv: ['plan', 'someid', '--from-archive', path.join(DELIVERY_WORKSPACE, 'missing-archive')],
    allowsStderr: true,
    assertResult: (result) => {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /ENOENT/);
      assert.doesNotMatch(result.stderr, /Unknown flag:/);
    },
  },
  {
    name: 'fix-selector someslug --bogusflag',
    argv: ['fix-selector', 'someslug', '--bogusflag'],
    assertResult: (result) => {
      assert.equal(result.status, 1);
      assert.equal(firstOutputLine(result.stdout), 'Unknown flag: --bogusflag.');
      assert.doesNotMatch(result.stdout + result.stderr, /Scanning generated specs/);
    },
  },
  {
    name: 'sessions --help --bogusflag',
    argv: ['sessions', '--help', '--bogusflag'],
    assertResult: (result) => {
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^Usage:\n/);
    },
  },
  {
    name: 'help --bogusflag',
    argv: ['help', '--bogusflag'],
    assertResult: (result) => {
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Usage/);
      assert.doesNotMatch(result.stdout, /Unknown flag:/);
    },
  },
] as const;

test('the recognized-unsupported-flag carve-out map has exactly one entry', () => {
  assert.deepEqual(Object.keys(RECOGNIZED_UNSUPPORTED_FLAGS), ['auth-setup'], 'every entry added here widens what unknown-flag validation lets through — add deliberately, with a probe row');
});

test('real-CLI delivery spawn roster remains explicitly enumerated', () => {
  assert.equal(REAL_CLI_UNKNOWN_FLAG_DELIVERY_CASES.length, 8, 'eight fixture rows plus the dedicated timeout-bound dashboard spawn: the eight named delivery spawns and the help meta-path row');
});

for (const deliveryCase of REAL_CLI_UNKNOWN_FLAG_DELIVERY_CASES) {
  test(`real-CLI delivery: ${deliveryCase.name}`, () => {
    const workspace = realCliDeliveryWorkspace();
    const result = runCliInFixture(workspace, [...deliveryCase.argv]);
    if (!deliveryCase.allowsStderr) assert.equal(result.stderr, '', `${deliveryCase.name} must not write stderr`);
    deliveryCase.assertResult(result);
  });
}

test('dashboard --bogusflag refuses in a timeout-bound real CLI spawn before starting the server', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      path.join(process.cwd(), 'src', 'cli.ts'),
      'dashboard',
      '--bogusflag',
    ],
    { cwd: realCliDeliveryWorkspace(), encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(result.error, undefined, 'dashboard validation must exit instead of exhausting the explicit timeout');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(firstOutputLine(result.stdout), 'Unknown flag: --bogusflag.');
});

const U1_META_UNKNOWN_FLAG_CASES = [
  { name: '--version --bogusflag', argv: ['--version', '--bogusflag'] },
  { name: '-v --bogusflag', argv: ['-v', '--bogusflag'] },
  { name: 'version --bogusflag', argv: ['version', '--bogusflag'] },
] as const;

test('version meta-path roster remains explicitly enumerated', () => {
  assert.equal(U1_META_UNKNOWN_FLAG_CASES.length, 3, 'all three version spellings must remain delivery-pinned');
});

for (const deliveryCase of U1_META_UNKNOWN_FLAG_CASES) {
  test(`version meta path: ${deliveryCase.name}`, () => {
    const result = runCliInFixture(realCliDeliveryWorkspace(), [...deliveryCase.argv]);
    assert.equal(result.status, 1, `${deliveryCase.name} must refuse the unknown flag`);
    assert.equal(result.stderr, '');
    assert.equal(firstOutputLine(result.stdout), 'Unknown flag: --bogusflag.');
  });
}

test('version aliases render identical unknown-flag output to the canonical verb', () => {
  const outputs: string[] = [];
  for (const deliveryCase of U1_META_UNKNOWN_FLAG_CASES) {
    const result = runCliInFixture(realCliDeliveryWorkspace(), [...deliveryCase.argv]);
    outputs.push(result.stdout);
  }
  assert.deepEqual(outputs, [outputs[0], outputs[0], outputs[0]], 'all three version spellings must render identical output');
});

test('unknown-flag census derives 24 verbs and 15 JSON-capable verbs from the canonical roster', () => {
  assert.equal(CLI_VERBS.length, 24);
  assert.equal(JSON_VERBS.length, 15);
});

test('every canonical verb refuses an unknown flag in prose mode, and JSON verbs keep the shared envelope', () => {
  const proseCases = CLI_VERBS.map((verb) => ({ verb, argv: unknownFlagArgs(verb, false) }));
  const jsonCases = JSON_VERBS.map((verb) => ({ verb, argv: unknownFlagArgs(verb, true) }));
  assert.equal(proseCases.length, 24);
  assert.equal(jsonCases.length, 15);

  for (const { verb, argv } of proseCases) {
    const result = captureUnknownFlag(argv);
    assert.equal(result.refused, true, `${verb} prose unknown flag must be refused`);
    assert.equal(result.exitCode, 1, `${verb} prose unknown flag must set exit code 1`);
    assert.deepEqual(result.output, [buildUnknownFlagUsageError(verb, '--bogus-flag')], `${verb} prose refusal must be one exact stdout line block`);
  }

  for (const { verb, argv } of jsonCases) {
    const result = captureUnknownFlag(argv);
    assert.equal(result.refused, true, `${verb} JSON unknown flag must be refused`);
    assert.equal(result.exitCode, 1, `${verb} JSON unknown flag must set exit code 1`);
    assert.equal(result.output.length, 1);
    const envelope = JSON.parse(result.output[0]!) as { error: { code: string; message: string } };
    assert.deepEqual(envelope, { error: { code: 'usage-error', message: buildUnknownFlagUsageError(verb, '--bogus-flag') } }, `${verb} JSON refusal must keep the shared envelope`);
  }
});

test('unknown-flag mode parity keeps the exact prose message inside the JSON envelope', () => {
  for (const verb of JSON_VERBS) {
    const prose = captureUnknownFlag(unknownFlagArgs(verb, false));
    const json = captureUnknownFlag(unknownFlagArgs(verb, true));
    const envelope = JSON.parse(json.output[0]!) as { error: { message: string } };
    assert.equal(envelope.error.message, prose.output[0]?.trimEnd(), `${verb} must render identical message bytes in both modes`);
  }
});

test('unknown-flag help precedence, separator, equals form, and class-C rendering stay pinned', () => {
  for (const verb of CLI_VERBS) {
    for (const helpFlag of ['--help', '-h']) {
      const result = captureUnknownFlag([verb, helpFlag, '--bogus-flag']);
      assert.equal(result.refused, false, `${verb} ${helpFlag} must win over unknown flags`);
      assert.deepEqual(result.output, []);
      assert.equal(result.exitCode, undefined);
    }
  }
  for (const [verb, argv, unknown] of [
    ['accept', ['--'], '--'],
    ['plan', ['fixture-distinctId', '--force=value'], '--force=value'],
  ] as const) {
    const result = captureUnknownFlag([verb, ...argv]);
    assert.equal(result.refused, true);
    assert.equal(result.output[0], buildUnknownFlagUsageError(verb, unknown));
  }
  const classC = captureUnknownFlag(['plan', 'fixture-distinctId', '--json', '--bogus-flag']);
  assert.equal(classC.output[0], buildUnknownFlagUsageError('plan', '--json'));
  assert.equal(classC.output[0]?.startsWith('{'), false, 'a class-C --json typo must stay prose');
});

test('usage-error lines stay byte-identical to the canonical help lines', () => {
  assert.equal(buildUsageErrorForPin('plan'), buildVerbUsageLine('plan'));
  assert.equal(buildUsageErrorForPin('frames'), buildVerbUsageLine('frames'));
});

test('compat-barrel direct entries keep the shared unknown-flag predicate', () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const explainOutput: string[] = [];
    runExplainFromCompat(['--bogus-flag'], { log: (line) => explainOutput.push(line) });
    assert.deepEqual(explainOutput, [buildUnknownFlagUsageError('explain', '--bogus-flag')]);
    assert.equal(process.exitCode, 1);

    process.exitCode = undefined;
    const retireOutput: string[] = [];
    runRetireFromCompat(['fixture-slug', '--bogus-flag'], { log: (line) => retireOutput.push(line) });
    assert.deepEqual(retireOutput, [buildUnknownFlagUsageError('retire', '--bogus-flag')]);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

function buildUsageErrorForPin(verb: 'plan' | 'frames'): string {
  return buildUsageError(verb);
}

function extractFunctionSource(source: string, name: string): string {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  assert.notEqual(match, null, `the drift guard's parser map must name a real function: ${name}`);
  const bodyMarker = /\)\s*(?:\:[^{]+)?\{/g;
  bodyMarker.lastIndex = match!.index;
  const bodyMatch = bodyMarker.exec(source);
  const openBrace = bodyMatch === null ? -1 : source.indexOf('{', bodyMatch.index);
  assert.notEqual(openBrace, -1, `${name} must have a function body`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match!.index, index + 1);
    }
  }
  throw new Error(`unterminated function body for ${name}`);
}

function flagReads(source: string): Set<string> {
  const flags = new Set<string>();
  const patterns = [
    /(?:readFlagValue|readNumberFlag)\(argv,\s*['"](--[a-z][a-z-]*)['"]/g,
    /[A-Za-z_]\w*\(argv,\s*['"](--[a-z][a-z-]*)['"]/g,
    /(?:argv|rest)\.(?:includes|indexOf)\(\s*['"](--[a-z][a-z-]*)['"]/g,
    /(?:arg|value|raw|previous)\s*(?:===|!==)\s*['"](--[a-z][a-z-]*)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) flags.add(match[1]!);
  }
  return flags;
}

function sourceText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function functionSourceIfPresent(source: string, name: string): string | undefined {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  return signature.test(source) ? extractFunctionSource(source, name) : undefined;
}

type RouterVerbRoute = {
  verb: CliVerb;
  source: string;
  modulePaths: readonly string[];
};

function routerVerbRoutes(): readonly RouterVerbRoute[] {
  const cliSource = sourceText('src/cli.ts');
  const switchSource = /switch \(command\) \{([\s\S]*?)\n    case 'help':/.exec(cliSource)?.[1];
  assert.notEqual(switchSource, undefined, 'the drift guard must locate the router switch before the meta-help cases');
  const importedHandlers = new Map(
    [...cliSource.matchAll(/import \{ (run[A-Za-z]+) \} from '(\.\/cli\/verbs\/[^']+)\.js';/g)]
      .map(([, handler, modulePath]) => [handler!, `src/${modulePath!.slice(2)}.ts`] as const),
  );
  const routes = [...switchSource!.matchAll(/case '([^']+)':([\s\S]*?)(?=\n    case '|\n    default:|$)/g)].map(([, candidate, caseSource]) => {
    assert.ok(CLI_VERBS.includes(candidate as CliVerb), `router case ${candidate} must be a canonical verb`);
    const modulePaths = [...new Set(
      [...importedHandlers]
        .filter(([handler]) => new RegExp(`\\b${handler}\\(`).test(caseSource!))
        .map(([, modulePath]) => modulePath),
    )];
    assert.ok(modulePaths.length > 0, `${candidate} must dispatch to at least one verb module`);
    return { verb: candidate as CliVerb, source: caseSource!, modulePaths };
  });
  assert.equal(routes.length, 24, 'the router-derived drift scan must cover the exact current verb count');
  assert.deepEqual(routes.map(({ verb }) => verb), CLI_VERBS, 'the router-derived drift scan must cover the canonical roster in router order');
  return routes;
}

function importedArgsParserSources(moduleSource: string, argsSource: string): readonly string[] {
  const importedArgs = [...moduleSource.matchAll(/import \{([^}]+)\} from '\.\.\/args\.js';/g)]
    .flatMap(([, specifiers]) => specifiers!.split(',').map((specifier) => specifier.trim().replace(/^type\s+/, '')))
    .filter((name) => /^parse[A-Z].*Args$/.test(name));
  const seen = new Set<string>();
  const collect = (name: string): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const source = functionSourceIfPresent(argsSource, name);
    if (source === undefined) return [];
    const helperNames = [...source.matchAll(/\b([A-Za-z_]\w*)\(argv(?:,|\))/g)].map(([, helper]) => helper!);
    return [source, ...helperNames.flatMap(collect)];
  };
  return importedArgs.flatMap(collect);
}

function parserFlagsByVerb(): Map<CliVerb, Set<string>> {
  const argsSource = sourceText('src/cli/args.ts');
  const result = new Map<CliVerb, Set<string>>();
  for (const route of routerVerbRoutes()) {
    const flags = new Set<string>();
    for (const modulePath of route.modulePaths) {
      const moduleSource = sourceText(modulePath);
      for (const flag of flagReads(moduleSource)) flags.add(flag);
      for (const parserSource of importedArgsParserSources(moduleSource, argsSource)) {
        for (const flag of flagReads(parserSource)) flags.add(flag);
      }
    }
    for (const flag of flagReads(route.source)) flags.add(flag);
    result.set(route.verb, flags);
  }
  return result;
}

function assertPerVerbFlagDrift(usageOverrides: Partial<Record<CliVerb, string>> = {}): void {
  const parserFlags = parserFlagsByVerb();
  for (const verb of CLI_VERBS) {
    const usage = usageOverrides[verb] ?? buildVerbUsageLine(verb);
    const advertised = new Set(usage.match(/--[a-z][a-z-]*/g) ?? []);
    // `--version` is a command alias normalized before this verb's argv is validated;
    // it is not a flag consumed by runVersion.
    if (verb === 'version') advertised.delete('--version');
    const recognized = new Set(RECOGNIZED_UNSUPPORTED_FLAGS[verb] ?? []);
    recognized.add('--help');
    const read = parserFlags.get(verb) ?? new Set<string>();
    const unread = [...advertised].filter((flag) => !read.has(flag) && !recognized.has(flag));
    const unadvertised = [...read].filter((flag) => !advertised.has(flag) && !recognized.has(flag));
    assert.deepEqual(unadvertised, [], `${verb} reads flags not covered by its usage line or recognized-unsupported table`);
    assert.deepEqual(unread, [], `${verb} advertises flags not read by its parser/handler`);
  }
}

test('per-verb flag drift guard covers both directions and its motivating archive defect', () => {
  assertPerVerbFlagDrift();
  const mutatedPlanUsage = buildVerbUsageLine('plan').replace('[--from-archive <dir>] ', '');
  assert.notEqual(mutatedPlanUsage, buildVerbUsageLine('plan'));
  assert.throws(
    () => assertPerVerbFlagDrift({ plan: mutatedPlanUsage }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /plan/.test(message);
    },
  );
});

test('every converted per-verb validation emits one real-CLI usage-error envelope', () => {
  assert.equal(JSON_VALIDATION_CASES.length, 15, 'the pin must enumerate all converted non-router validation emissions');
  for (const usageCase of JSON_VALIDATION_CASES) assertRealCliUsageEnvelope(usageCase);
});

test('JSON verb routing refuses the unsupported separator and equals-value forms', () => {
  const cases = [
    { name: 'bare option separator', argv: ['accept', '--json', '--'], unknown: '--', exitCode: 1 },
    { name: 'equals-value option', argv: ['accept', '--json', '--force=value'], unknown: '--force=value', exitCode: 1 },
  ] as const;
  assert.equal(cases.length, 2, 'both now-refused argument forms must remain pinned');
  for (const usageCase of cases) {
    assertRealCliUsageEnvelope(usageCase);
    const result = runCliInFixture(process.cwd(), [...usageCase.argv]);
    const envelope = JSON.parse(result.stdout) as { error: { message: string } };
    assert.match(envelope.error.message, new RegExp(`Unknown flag: ${usageCase.unknown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  }
});

test('explain real CLI emits an integer exitCode for every situation and preserves role-dependent outcomes', () => {
  const result = runCliInFixture(process.cwd(), ['explain', 'privacy-workspace-not-ignored', '--json']);
  assert.equal(result.status, 0, `the dual-role explain fixture must resolve\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout) as { cases: Array<{ exitCode: unknown }> };
  assert.ok(envelope.cases.length >= 2, 'the fixture must contain enough situations to disprove a constant-code projection');
  for (const [index, situation] of envelope.cases.entries()) {
    assert.equal(Number.isInteger(situation.exitCode), true, `situation ${index} must carry an integer exitCode`);
  }
  assert.ok(new Set(envelope.cases.map(({ exitCode }) => exitCode)).size >= 2, 'the fixture must preserve at least two different situation exit codes');
});

test('explain real CLI preserves a non-mutating usage-error exit code across text and JSON modes', () => {
  const entry = JSON_VALIDATION_CASES.find(({ name }) => name === 'explain full without list');
  assert.notEqual(entry, undefined, 'the parity pin must reuse the converted-validation table entry');
  if (entry === undefined) return;
  const text = runCliInFixture(process.cwd(), entry.argv.filter((argument) => argument !== '--json'));
  const json = runCliInFixture(process.cwd(), [...entry.argv]);
  assert.equal(text.status, json.status, 'text and JSON modes must return the same process exit code for one usage error');
  assert.equal(json.status, entry.exitCode, 'the real process status must match the table entry exitCode');
  assert.equal(text.stderr, '');
  assert.equal(json.stderr, '');
  const envelope = JSON.parse(json.stdout) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'usage-error');
  assert.equal(envelope.error.message, text.stdout.trimEnd(), 'both modes must report the same usage error');
});

const OUTCOME_RUNNERS: Record<Exclude<CliVerb, 'dashboard'>, OutcomeRunner> = {
  init: (log) => runInit([], { log }),
  version: (log) => runVersion([], { log }),
  sessions: (log) => runSessions([], { log, getProviderConfigStatus: unconfigured, getWizardStepConfig: defaultWizardConfig }),
  gaps: async (log) => await runGaps([], { log, getProviderConfigStatus: unconfigured, getWizardStepConfig: defaultWizardConfig }),
  'scan-status': (log) => runScanStatus([], { log, getProjectFingerprint: () => undefined }),
  plan: async (log) => await runPlan([], { log, getProviderConfigStatus: unconfigured, getWizardStepConfig: defaultWizardConfig }),
  scaffold: (log) => runScaffold([], { log }),
  frames: async (log) => await runFramesCommand([], { log }),
  repro: async (log) => await runRepro([], { log, getProviderConfigStatus: unconfigured }),
  preflight: async (log) => await runPreflight([], { log }),
  triage: async (log) => await runTriage([], { log }),
  regenerate: async (log) => await runRegenerate([], { log }),
  diff: (log) => runDiff([], { log }),
  doctor: async (log) => await runDoctor([], { log, getProviderConfigStatus: unconfigured }),
  heal: async (log) => await runHeal([], { log, getProviderConfigStatus: unconfigured }),
  accept: (log) => runAccept([], { log }),
  retire: (log) => runRetire([], { log }),
  'suite-status': async (log) => await runSuiteStatus([], { log, getProviderConfigStatus: unconfigured, getWizardStepConfig: defaultWizardConfig }),
  'suite-health': async (log) => await runSuiteHealth([], { log, getProviderConfigStatus: unconfigured, getWizardStepConfig: defaultWizardConfig }),
  reconcile: (log) => runReconcile([], { log }),
  'fix-selector': (log) => runFixSelector([], { log }),
  'auth-setup': (log) => runAuthSetup([], { readDirectory: () => [], log }),
  explain: (log) => runExplain([], { log }),
};

test('CLI outcome guard: every canonical non-blocking verb emits a collector-visible outcome', async () => {
  // Explicit, justified exemptions: dashboard binds a blocking server and its
  // listen banner is live-verified; help is not a CLI_VERBS member at all.
  const auditedVerbs = CLI_VERBS.filter((verb) => verb !== 'dashboard');
  assert.deepEqual(Object.keys(OUTCOME_RUNNERS).sort(), [...auditedVerbs].sort());
  assert.equal(CLI_VERBS.includes('help' as CliVerb), false);

  const originalExitCode = process.exitCode;
  try {
    for (const verb of auditedVerbs) {
      process.exitCode = undefined;
      const output: string[] = [];
      await OUTCOME_RUNNERS[verb]((line) => output.push(line));
      assert.ok(output.some((line) => line.trim().length > 0), `${verb} must emit a visible outcome`);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runAccept: handler-level success names both promoted plan artifacts and the next command', (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-accept-handler-'));
  fs.writeFileSync(
    path.join(plansDir, 'checkout.proposed.plan.json'),
    `${JSON.stringify({
      version: 1,
      title: 'Checkout',
      source: {
        distinctId: 'user-1',
        sessionId: 'session-1',
        journeyIndex: 0,
        signature: '/cart > /confirmation',
        generatedAt: '2026-08-12T00:00:00.000Z',
        tool: 'replaytest@0.1.0',
      },
      start: '/cart',
      steps: [{ action: 'click', label: 'Pay', locator: "getByRole('button', { name: 'Pay' })" }],
      assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
    }, null, 2)}\n`,
    'utf8',
  );

  const output: string[] = [];
  runAccept(['checkout'], {
    plansDir,
    now: () => new Date('2026-08-12T00:00:00.000Z'),
    log: (line) => output.push(line),
  });

  assert.equal(output.length, 1);
  assert.match(output[0], /Accepted checkout\./);
  assert.match(output[0], /Wrote .*checkout\.plan\.json/);
  assert.match(output[0], /Wrote .*checkout\.md/);
  assert.match(output[0], /Next: If tests\/generated\/checkout\.spec\.ts has no hand edits, run `replaytest scaffold checkout --force`/);
  assert.match(output[0], /otherwise apply the reviewed delta yourself/);
});

test('CLI success outcome guard: injected plan and scaffold writes name every produced user artifact', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-cli-success-outcomes-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('1001'));
  const planOutput: string[] = [];
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
      plansDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: defaultWizardConfig,
      fetchNeutralSessionsWithDomEnrichment: async () => [session],
      log: (line) => planOutput.push(line),
    });

    assert.deepEqual(planOutput, [
      // The guard is that the line names every artifact the run produced — so
      // it must name the directory they were actually written to, which here
      // is the injected one, not the default.
      `Wrote orders-confirmation -> ${plansDir}/orders-confirmation.md + .plan.json`,
      'Tip: replaytest frames orders-confirmation — per-step DOM + screenshots for your coding agent (recordings expire; run it early).',
    ]);
    assert.equal(fs.existsSync(path.join(plansDir, 'orders-confirmation.plan.json')), true);
    assert.equal(fs.existsSync(path.join(plansDir, 'orders-confirmation.md')), true);

    const scaffoldOutput: string[] = [];
    runScaffold(['orders-confirmation'], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      specEmittedHashesPath: path.join(root, '.replaytest', 'state', 'spec-emitted-hashes.json'),
      log: (line) => scaffoldOutput.push(line),
    });

    assert.deepEqual(scaffoldOutput.slice(0, 2), [
      'Wrote tests/generated/orders-confirmation.spec.ts',
      'Wrote .replaytest/plans/orders-confirmation.md',
    ]);
    assert.equal(fs.existsSync(path.join(generatedTestsDir, 'orders-confirmation.spec.ts')), true);
    assert.equal(fs.existsSync(path.join(root, '.replaytest', 'state', 'spec-emitted-hashes.json')), true);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions progress: injected multi-page provider work reaches stderr before the final stdout render', () => {
  const tableHeader = 'timestamp|uuid|event|event_type|url|session_id|distinct_id|chain_b64';
  const pageOutputs = [
    JSON.stringify(`${tableHeader}\n2026-08-12T00:00:00.000Z|row-1|$pageview||https://example.test/cart|session-1|user-1|\n`),
    JSON.stringify(tableHeader),
  ];
  const nowValues = [0, 1_000, 2_000];
  const events: string[] = [];
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runSessions(['--exact'], {
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: defaultWizardConfig,
      progress: (line) => events.push(`progress:${line}`),
      log: (line) => events.push(`log:${line}`),
      completionCensus: {
        isLiveScan: true,
        write: (_root, entry) => ({ version: 1, latest: entry, history: [] }),
      },
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-12T00:00:00.000Z' }),
        fetchAllSessions: () => fetchAllSessions({
          progress: (line) => events.push(`progress:${line}`),
          now: () => nowValues.shift() ?? 2_000,
          postHogCliRunDeps: {
            exec: () => ({ status: 0, stdout: pageOutputs.shift() ?? JSON.stringify(tableHeader) }),
            sleep: () => { throw new Error('a clean two-page fetch must not back off'); },
          },
        }),
      },
    });
  } finally {
    process.exitCode = originalExitCode;
  }

  assert.equal(events.filter((line) => line.startsWith('progress:')).length, 4);
  assert.equal(events[0], 'progress:Exact scan reads every session — ~1 session.');
  assert.equal(events[1], 'progress:Exact session scan: 1 page fetched (1 event row seen; 1.0s elapsed).');
  assert.equal(events[2], 'progress:Exact session scan: 2 pages fetched (1 event row seen; 2.0s elapsed).');
  assert.equal(events[3], 'progress:Wrote .replaytest/state/completion-census.json.');
  assert.match(events.at(-1) ?? '', /^log:/);
});
