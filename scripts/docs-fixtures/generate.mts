/**
 * Regenerates the safe, public CLI-output fixtures embedded in docs/site.
 *
 * Every verb now handles its own `--help`/`-h` (checked before ANY
 * workspace/config read, provider call, or server start — see
 * `maybePrintVerbHelp` in `src/cli/help.ts`), so every one of these commands is
 * safe: none of them can read workspace/provider data or start the
 * dashboard server. The allow-list below stays explicit anyway, as drift
 * protection — a brand-new verb still needs to be added here deliberately,
 * and (per the same inspection discipline this list has always used) its
 * `--help` handling verified before it's trusted with a public fixture.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_FIXTURES_DIRECTORY = path.join(repoRoot, 'docs', 'site', 'fixtures');

export interface CliFixture {
  name: string;
  args: string[];
}

/**
 * One fixture for the top-level `help` listing, plus one per verb's own
 * `--help` synopsis — every verb the CLI router dispatches to. Do not add a
 * fixture for a new verb until its `--help` handling has been inspected for
 * the same "no side effect before the synopsis prints" property.
 */
export const SAFE_CLI_FIXTURES: readonly CliFixture[] = [
  { name: 'cli-help', args: ['--help'] },
  { name: 'cli-help-init', args: ['init', '--help'] },
  { name: 'cli-help-version', args: ['version', '--help'] },
  { name: 'cli-help-sessions', args: ['sessions', '--help'] },
  { name: 'cli-help-gaps', args: ['gaps', '--help'] },
  { name: 'cli-help-scan-status', args: ['scan-status', '--help'] },
  { name: 'cli-help-plan', args: ['plan', '--help'] },
  { name: 'cli-help-scaffold', args: ['scaffold', '--help'] },
  { name: 'cli-help-frames', args: ['frames', '--help'] },
  { name: 'cli-help-repro', args: ['repro', '--help'] },
  { name: 'cli-help-preflight', args: ['preflight', '--help'] },
  { name: 'cli-help-triage', args: ['triage', '--help'] },
  { name: 'cli-help-regenerate', args: ['regenerate', '--help'] },
  { name: 'cli-help-diff', args: ['diff', '--help'] },
  { name: 'cli-help-doctor', args: ['doctor', '--help'] },
  { name: 'cli-help-heal', args: ['heal', '--help'] },
  { name: 'cli-help-accept', args: ['accept', '--help'] },
  { name: 'cli-help-retire', args: ['retire', '--help'] },
  { name: 'cli-help-suite-status', args: ['suite-status', '--help'] },
  { name: 'cli-help-suite-health', args: ['suite-health', '--help'] },
  { name: 'cli-help-reconcile', args: ['reconcile', '--help'] },
  { name: 'cli-help-fix-selector', args: ['fix-selector', '--help'] },
  { name: 'cli-help-auth-setup', args: ['auth-setup', '--help'] },
  { name: 'cli-help-dashboard', args: ['dashboard', '--help'] },
  { name: 'cli-help-explain', args: ['explain', '--help'] },
];

function runCli(args: readonly string[]): string {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) throw new Error(`CLI ${args.join(' ')} ended from signal ${result.signal}`);
  // Every fixture above is a `--help` invocation, which must always exit 0 — a
  // nonzero exit here means some verb's `--help` regressed back to a usage
  // error (or worse, a real failure), so this is a real assertion, not
  // leniency.
  if (result.status !== 0) {
    throw new Error(`CLI ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  if (result.stderr !== '') throw new Error(`CLI ${args.join(' ')} wrote to stderr: ${result.stderr}`);
  return result.stdout;
}

/** Runs every safe help command once and returns its raw stdout by fixture name. */
export function generateCliFixtureOutputs(): Map<string, string> {
  return new Map(SAFE_CLI_FIXTURES.map((fixture) => [fixture.name, runCli(fixture.args)]));
}

function firstDifferentLine(existing: string, generated: string): string {
  const existingLines = existing.split('\n');
  const generatedLines = generated.split('\n');
  const index = existingLines.findIndex((line, lineIndex) => line !== generatedLines[lineIndex]);
  const line = index === -1 ? Math.min(existingLines.length, generatedLines.length) : index;
  const existingLine = existingLines[line] ?? '';
  const generatedLine = generatedLines[line] ?? '';
  return [
    `--- existing line ${line + 1}`,
    `+++ fresh CLI line ${line + 1}`,
    `-${existingLine}`,
    `+${generatedLine}`,
  ].join('\n');
}

function writeFixture(name: string, output: string, force: boolean): 'verified' | 'wrote' | 'updated' {
  const fixturePath = path.join(CLI_FIXTURES_DIRECTORY, `${name}.txt`);
  if (!fs.existsSync(fixturePath)) {
    fs.writeFileSync(fixturePath, output, 'utf8');
    return 'wrote';
  }

  const existing = fs.readFileSync(fixturePath, 'utf8');
  if (existing === output) return 'verified';

  const difference = firstDifferentLine(existing, output);
  if (!force) {
    throw new Error(
      `${path.relative(repoRoot, fixturePath)} differs from fresh CLI output; refusing to overwrite the seeded expectation.\n${difference}\nRun this generator again with --force only after reviewing the change.`,
    );
  }

  console.error(`${path.relative(repoRoot, fixturePath)} differs from fresh CLI output:\n${difference}`);
  fs.writeFileSync(fixturePath, output, 'utf8');
  return 'updated';
}

export function writeCliFixtures(force = false): void {
  fs.mkdirSync(CLI_FIXTURES_DIRECTORY, { recursive: true });
  const outputs = generateCliFixtureOutputs();
  for (const [name, output] of outputs) {
    const outcome = writeFixture(name, output, force);
    console.log(`${outcome === 'verified' ? 'Verified' : outcome === 'updated' ? 'Updated' : 'Wrote'} ${path.relative(repoRoot, path.join(CLI_FIXTURES_DIRECTORY, `${name}.txt`))}.`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--force')) {
    throw new Error('Usage: node --import tsx scripts/docs-fixtures/generate.mts [--force]');
  }
  writeCliFixtures(args.includes('--force'));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`docs fixture generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
