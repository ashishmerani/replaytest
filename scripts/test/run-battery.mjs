/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const TEST_CONCURRENCY_ENV = 'REPLAYTEST_TEST_CONCURRENCY';

/** Selects which corpus the provider-isolation tripwire reads: `full` reads the whole local corpus; unset or `trimmed` reads the committed trimmed one; any other value is refused. */
export const CORPUS_MODE_ENV = 'REPLAYTEST_ISOLATION_CORPUS';

/** Measured duration of the full-corpus leg on an unencumbered 18-core machine. */
export const FULL_CORPUS_LEG_MINUTES = 21;

/**
 * The corpus-dependent file, announced up front so a long quiet stretch reads as work
 * rather than as a hang. Which announcement is true depends on the corpus mode: the
 * committed trimmed corpus (the default, and what every merge runs) finishes in seconds;
 * the full local corpus, which `REPLAYTEST_ISOLATION_CORPUS=full` selects, is the
 * battery's longest single file by a wide margin. The file exists only in the development
 * tree, so the announcement is made only where the file is present (see `runBattery`).
 */
export const LONGEST_TEST_PATH = 'src/benchmark/provider-isolation.test.ts';

export function longestTestNotice(corpusMode) {
  return corpusMode === 'full'
    ? `battery: longest test ${LONGEST_TEST_PATH} — about ${FULL_CORPUS_LEG_MINUTES} minutes on an 18-core machine, because ${CORPUS_MODE_ENV}=full points it at the full local benchmark corpus\n`
    : `battery: ${LONGEST_TEST_PATH} reads its committed trimmed corpus — seconds; ${CORPUS_MODE_ENV}=full points it at the full local corpus instead (about ${FULL_CORPUS_LEG_MINUTES} minutes, the full-corpus run)\n`;
}

/** @param {string} relativePath */
function existsInRepository(relativePath) {
  return fs.existsSync(path.join(REPOSITORY_ROOT, relativePath));
}

export function availableCoreCount(osApi = os) {
  return typeof osApi.availableParallelism === 'function'
    ? osApi.availableParallelism()
    : osApi.cpus().length;
}

export function chooseTestConcurrency(coreCount, envValue) {
  const override = typeof envValue === 'string' && /^[1-9][0-9]*$/.test(envValue) ? Number(envValue) : Number.NaN;
  if (Number.isSafeInteger(override) && override >= 1) return override;
  return coreCount <= 3 ? 1 : Math.max(2, Math.floor(coreCount / 3));
}

export function buildTestRunnerArgs(rosterArgs, coreCount, envValue) {
  const testFlagIndex = rosterArgs.indexOf('--test');
  if (testFlagIndex === -1) throw new Error('package.json scripts.test must include the --test flag');

  const forwarded = rosterArgs.slice(testFlagIndex);
  const concurrency = chooseTestConcurrency(coreCount, envValue);
  return {
    args: ['--import', 'tsx', `--test-concurrency=${concurrency}`, ...forwarded],
    concurrency,
    coreCount,
    roster: forwarded.slice(1),
  };
}

export function runBattery(
  rosterArgs = process.argv.slice(2),
  {
    osApi = os,
    envValue = process.env[TEST_CONCURRENCY_ENV],
    corpusMode = process.env[CORPUS_MODE_ENV],
    spawnSync = defaultSpawnSync,
    stderr = process.stderr,
    fileExists = existsInRepository,
  } = {},
) {
  const coreCount = availableCoreCount(osApi);
  const plan = buildTestRunnerArgs(rosterArgs, coreCount, envValue);
  stderr.write(`test-concurrency: ${plan.concurrency} (${plan.coreCount} cores)\n`);
  if (coreCount <= 3 && !(typeof envValue === 'string' && /^[1-9][0-9]*$/.test(envValue))) {
    stderr.write(`battery: <=3 cores → serial file execution; ${TEST_CONCURRENCY_ENV}=<n> overrides the file concurrency\n`);
  }
  // Only when that file is in this roster and on disk — a focused run, or a checkout that does not
  // carry the file, must not be told to expect it.
  if (plan.roster.includes(LONGEST_TEST_PATH) && fileExists(LONGEST_TEST_PATH)) stderr.write(longestTestNotice(corpusMode));
  const result = spawnSync(process.execPath, plan.args, { stdio: 'inherit' });
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBattery();
}
