/** Gate 2 release smoke: prepare a real tarball, then verify a human-installed consumer. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { isPlanArtifactFileName, readArtifactDirectory, type ArtifactMap } from '../eval/eval-goldens-lib.mts';
import { checkDistFreshness, parseBuildMeta } from './build-stamp-lib.mts';
import { collectBuildSourcePaths, type PackageManifest } from './pack-contract-lib.js';
import {
  GATE2_GOLDEN_SESSION_IDS,
  GATE2_STATE_FILE,
  assertRealTarballContract,
  buildGate2Paths,
  checkConsumerPins,
  compareGoldenArtifacts,
  consumerManifestSeed,
  installCommand,
  newestStatePath,
  normalizeArchivePathEcho,
  parseGate2State,
  parseShippedDependencyPins,
  serializeGate2State,
  type Gate2FileOps,
  type Gate2State,
} from './pack-install-consume-lib.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateRoot = buildGate2Paths(os.tmpdir(), 'placeholder').baseDir;

type PackResult = {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
};

type CommandResult = {
  status: number | null;
  output: string;
  error?: string;
};

function printUsage(): void {
  console.log('Usage: npm run gate2:prepare | npm run gate2:verify [-- --state <absolute-state-path>]');
}

function runCommand(command: string, args: string[], cwd: string, env = process.env): CommandResult {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error?.message,
  };
}

function runChecked(command: string, args: string[], cwd: string, env = process.env): void {
  const result = runCommand(command, args, cwd, env);
  if (result.error !== undefined) throw new Error(`could not run ${command}: ${result.error}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 'unknown'}):\n${result.output.trim()}`);
}

function packageManifest(): PackageManifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageManifest;
}

function makeRunId(): string {
  return `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function parsePackResult(raw: string): PackResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`npm pack did not return parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${raw.trim()}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('npm pack must return exactly one package manifest');
  const result = parsed[0] as Partial<PackResult>;
  if (typeof result.name !== 'string' || typeof result.version !== 'string' || typeof result.filename !== 'string' || !Array.isArray(result.files)) {
    throw new Error('npm pack returned an incomplete package manifest');
  }
  return result as PackResult;
}

function prepare(): void {
  const createdAt = new Date().toISOString();
  const paths = buildGate2Paths(os.tmpdir(), makeRunId());
  fs.mkdirSync(paths.runDir, { recursive: true });

  console.log('Gate 2 prepare: building the distributable.');
  runChecked('npm', ['run', 'build'], repoRoot);
  console.log('PASS build completed before packing.');

  // `ignore-scripts=true` means `npm pack`/`npm publish` never
  // runs `prepack`, so a silently-broken (or simply skipped) build could
  // otherwise ship a stale dist/ unnoticed. Prove the dist/ about to be
  // packed was actually built from the src tree on disk right now, BEFORE
  // packing it — this is the structural gate the ignore-scripts posture
  // means we can never get for free.
  const distRoot = path.join(repoRoot, 'dist');
  const freshness = checkDistFreshness(repoRoot, distRoot);
  if (!freshness.fresh) {
    throw new Error(`dist/ is stale even after \`npm run build\` just ran: ${freshness.reason ?? 'unknown reason'}. Run \`npm run build\` and investigate before releasing.`);
  }
  console.log('PASS dist/ build stamp matches the current src tree.');

  const pack = runCommand('npm', ['pack', '--json', '--pack-destination', paths.runDir], repoRoot, {
    ...process.env,
    // Keep the real pack independent of a developer's global npm-cache
    // ownership, while retaining its exact package/pack-destination surface.
    npm_config_cache: path.join(paths.runDir, 'npm-cache'),
  });
  if (pack.error !== undefined) throw new Error(`could not run npm pack: ${pack.error}`);
  if (pack.status !== 0) throw new Error(`npm pack failed (exit ${pack.status ?? 'unknown'}):\n${pack.output.trim()}`);
  const packed = parsePackResult(pack.output);
  const tarballs = fs.readdirSync(paths.runDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`expected exactly one .tgz in ${paths.runDir}, found ${tarballs.length}`);
  const tarball = path.join(paths.runDir, tarballs[0].name);
  if (path.basename(tarball) !== packed.filename) throw new Error(`npm pack named ${packed.filename}, but the produced tarball was ${tarballs[0].name}`);
  console.log(`PASS npm pack produced exactly one tarball: ${tarball}`);

  assertRealTarballContract(fs.readFileSync(tarball), packageManifest(), collectBuildSourcePaths(repoRoot));
  console.log('PASS real tarball contents satisfy the shared Gate-1 contract.');

  fs.mkdirSync(paths.consumerDir, { recursive: true });
  fs.writeFileSync(path.join(paths.consumerDir, 'package.json'), consumerManifestSeed(), 'utf8');
  console.log(`PASS seeded pristine consumer manifest: ${path.join(paths.consumerDir, 'package.json')}`);

  const preparedAt = new Date().toISOString();
  const state: Gate2State = {
    schemaVersion: 1,
    runId: path.basename(paths.runDir),
    repoRoot,
    archiveDir: path.join(repoRoot, 'archive'),
    tarball,
    consumer: paths.consumerDir,
    createdAt,
    packedAt: preparedAt,
    preparedAt,
    srcDigest: freshness.currentDigest,
  };
  fs.writeFileSync(paths.statePath, serializeGate2State(state), 'utf8');

  console.log('\nGate 2 prepare summary');
  console.log(`State file: ${paths.statePath}`);
  console.log(`Run directory (cleanup candidate; not deleted): ${paths.runDir}`);
  console.log('Run this exact install command yourself (the gate never installs the tarball):');
  console.log(installCommand(state.consumer, state.tarball));
  console.log('Then, from this repository, run: npm run gate2:verify');
}

function findDefaultStatePath(): string | undefined {
  let runs: fs.Dirent[];
  try {
    runs = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = runs
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const statePath = path.join(stateRoot, entry.name, GATE2_STATE_FILE);
      try {
        return [{ statePath, modifiedAtMs: fs.statSync(statePath).mtimeMs }];
      } catch {
        return [];
      }
    });
  return newestStatePath(candidates);
}

function parseVerifyState(argv: string[]): Gate2State {
  let statePath: string | undefined;
  if (argv.length === 0) statePath = findDefaultStatePath();
  else if (argv.length === 2 && argv[0] === '--state') statePath = path.resolve(argv[1]);
  else throw new Error('verify accepts only --state <path>');
  if (statePath === undefined) throw new Error(`no Gate-2 state file found under ${stateRoot}; run npm run gate2:prepare first`);
  try {
    return parseGate2State(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load Gate-2 state ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function configlessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.POSTHOG_PERSONAL_API_KEY;
  delete environment.POSTHOG_PROJECT_ID;
  delete environment.POSTHOG_API_HOST;
  return environment;
}

const fileOps: Gate2FileOps = {
  readdir: (directory) => fs.readdirSync(directory, { withFileTypes: true }),
  exists: (filePath) => fs.existsSync(filePath),
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
};

function reportResult(label: string, passed: boolean, detail?: string): boolean {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail === undefined || detail.length === 0 ? '' : ` — ${detail}`}`);
  return passed;
}

function commandFailure(result: CommandResult): string {
  if (result.error !== undefined) return `could not start: ${result.error}`;
  return `exit ${result.status ?? 'unknown'}${result.output.trim().length > 0 ? `; ${result.output.trim()}` : ''}`;
}

function formatComparisonFailure(comparison: ReturnType<typeof compareGoldenArtifacts>): string {
  const details: string[] = [comparison.verdict];
  if (comparison.extraGoldens.length > 0) details.push(`missing generated: ${comparison.extraGoldens.join(', ')}`);
  if (comparison.missingGoldens.length > 0) details.push(`unexpected generated: ${comparison.missingGoldens.join(', ')}`);
  if (comparison.changed.length > 0) details.push(`changed: ${comparison.changed.join(', ')}`);
  return details.join('; ');
}

function directorySize(directory: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(fullPath);
        else if (!entry.isSymbolicLink()) total += fs.statSync(fullPath).size;
      } catch {
        // A concurrently changed scratch file is immaterial to the candidate listing.
      }
    }
  };
  walk(directory);
  return total;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function verify(argv: string[]): void {
  const state = parseVerifyState(argv);
  const installedPackage = path.join(state.consumer, 'node_modules', 'replaytest');
  const installedBin = path.join(state.consumer, 'node_modules', '.bin', 'replaytest');
  const command = installCommand(state.consumer, state.tarball);
  if (!fs.existsSync(installedPackage) || !fs.existsSync(installedBin)) {
    throw new Error(`install has not happened in the prepared consumer. Run: ${command}; then rerun npm run gate2:verify from this repository.`);
  }

  console.log(`Gate 2 verify: loaded ${state.runId}.`);
  const results: boolean[] = [];
  try {
    assertRealTarballContract(fs.readFileSync(state.tarball), packageManifest(), collectBuildSourcePaths(repoRoot));
    results.push(reportResult('real tarball still satisfies the shared Gate-1 file contract', true));
  } catch (error) {
    results.push(reportResult('real tarball still satisfies the shared Gate-1 file contract', false, error instanceof Error ? error.message : String(error)));
  }

  // Proves the installed consumer runs the code that was just
  // built, not a stale dist that merely happened to satisfy Gate 1's
  // presence-only mechanism check. The digest recorded at prepare time (over
  // the src tree that produced this exact tarball) must match the stamp
  // actually shipped and unpacked into the consumer's node_modules.
  try {
    const installedMeta = parseBuildMeta(fs.readFileSync(path.join(installedPackage, 'dist', '.build-meta.json'), 'utf8'));
    const matches = installedMeta.srcDigest === state.srcDigest;
    results.push(
      reportResult(
        'installed dist build stamp matches the digest recorded at prepare time',
        matches,
        matches ? undefined : `installed srcDigest ${installedMeta.srcDigest} != prepared srcDigest ${state.srcDigest}`,
      ),
    );
  } catch (error) {
    results.push(reportResult('installed dist build stamp matches the digest recorded at prepare time', false, error instanceof Error ? error.message : String(error)));
  }

  const environment = configlessEnvironment();
  const help = runCommand(installedBin, ['--help'], state.consumer, environment);
  results.push(reportResult('installed replaytest --help exits 0 and prints usage', help.status === 0 && /Usage:/i.test(help.output), help.status === 0 && /Usage:/i.test(help.output) ? undefined : commandFailure(help)));

  const doctor = runCommand(installedBin, ['doctor'], state.consumer, environment);
  const doctorOutput = doctor.output.trimStart();
  results.push(
    reportResult(
      'installed replaytest doctor honestly refuses missing configuration',
      doctor.status === 1 && doctorOutput.startsWith('Cannot run doctor:'),
      doctor.status === 1 && doctorOutput.startsWith('Cannot run doctor:') ? undefined : commandFailure(doctor),
    ),
  );

  try {
    const pins = parseShippedDependencyPins(fs.readFileSync(path.join(installedPackage, 'package.json'), 'utf8'));
    const pinCheck = checkConsumerPins(path.join(state.consumer, 'node_modules'), pins, fileOps);
    results.push(reportResult('every consumer copy of every shipped dependency matches its exact pin', pinCheck.failures.length === 0, pinCheck.failures.join('; ')));
  } catch (error) {
    results.push(reportResult('every consumer copy of every shipped dependency matches its exact pin', false, error instanceof Error ? error.message : String(error)));
  }

  // The installed CLI writes plans FLAT to <cwd>/.replaytest/plans/<slug>.*
  // (only the dev-tree eval harness redirects per session), so generated
  // artifacts are collected by golden file name plus a before/after delta
  // for anything unexpected the run produced.
  const consumerPlansDir = path.join(state.consumer, '.replaytest', 'plans');
  const listPlanFileNames = (): Set<string> => {
    try {
      return new Set(
        fs
          .readdirSync(consumerPlansDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && isPlanArtifactFileName(entry.name))
          .map((entry) => entry.name),
      );
    } catch {
      return new Set();
    }
  };
  for (const sessionId of GATE2_GOLDEN_SESSION_IDS) {
    const namesBefore = listPlanFileNames();
    const plan = runCommand(installedBin, ['plan', sessionId, '--from-archive', state.archiveDir], state.consumer, environment);
    if (plan.status !== 0) {
      results.push(reportResult(`installed plan ${sessionId} matches its committed golden`, false, commandFailure(plan)));
      continue;
    }
    try {
      const goldens = readArtifactDirectory(path.join(state.archiveDir, 'goldens', sessionId), { normalize: false, includeEmptyMarker: false });
      const generated: ArtifactMap = new Map();
      const readGenerated = (name: string): string =>
        normalizeArchivePathEcho(fs.readFileSync(path.join(consumerPlansDir, name), 'utf8'), state.archiveDir);
      for (const name of goldens.keys()) {
        if (fs.existsSync(path.join(consumerPlansDir, name))) generated.set(name, readGenerated(name));
      }
      for (const name of listPlanFileNames()) {
        if (!namesBefore.has(name) && !generated.has(name)) generated.set(name, readGenerated(name));
      }
      const comparison = compareGoldenArtifacts(goldens, generated);
      const passed = comparison.verdict === 'PASS';
      results.push(reportResult(`installed plan ${sessionId} matches its committed golden`, passed, passed ? undefined : formatComparisonFailure(comparison)));
      if (!passed && comparison.diffExcerpt.length > 0) console.log(comparison.diffExcerpt.map((line) => `  ${line}`).join('\n'));
    } catch (error) {
      results.push(reportResult(`installed plan ${sessionId} matches its committed golden`, false, error instanceof Error ? error.message : String(error)));
    }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nGate 2 verification summary: ${passed}/${results.length} assertions passed.`);
  console.log(`Cleanup candidate (not deleted): ${path.dirname(state.consumer)} (${formatByteSize(directorySize(path.dirname(state.consumer)))})`);
  if (passed !== results.length) process.exitCode = 1;
}

function main(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'prepare' && rest.length === 0) prepare();
  else if (subcommand === 'verify') verify(rest);
  else {
    printUsage();
    process.exitCode = 1;
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Gate 2 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
