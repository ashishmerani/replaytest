/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  availableCoreCount,
  buildTestRunnerArgs,
  chooseTestConcurrency,
  CORPUS_MODE_ENV,
  FULL_CORPUS_LEG_MINUTES,
  longestTestNotice,
  LONGEST_TEST_PATH,
  runBattery,
  TEST_CONCURRENCY_ENV,
} from './run-battery.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Present only in the development tree (the same discriminator `requireDevTreeInputOrSkip` uses).
const DEV_TREE_MARKER = path.join(REPO_ROOT, 'scripts', 'promotion', 'stage-manifest.json');

// Exercise default-mode cases under the same hostile overrides as a full battery.
function withAmbientLauncherOverrides(operation) {
  const overrides = { [TEST_CONCURRENCY_ENV]: '4', [CORPUS_MODE_ENV]: 'full' };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try { operation(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('core-scaled concurrency formula and override policy are pinned', () => {
  assert.equal(chooseTestConcurrency(18), 6);
  assert.equal(chooseTestConcurrency(4), 2);
  assert.equal(chooseTestConcurrency(1), 1);
  assert.equal(chooseTestConcurrency(2), 1);
  assert.equal(chooseTestConcurrency(3), 1);
  assert.equal(chooseTestConcurrency(7), 2);
  assert.equal(chooseTestConcurrency(10), 3);
  assert.equal(chooseTestConcurrency(18, '9'), 9);
  assert.equal(chooseTestConcurrency(18, 'garbage'), 6);
  for (const invalid of ['0x10', '2.5', '1e1', ' 3', '', '0', '01']) {
    assert.equal(chooseTestConcurrency(18, invalid), 6, JSON.stringify(invalid));
  }
});

test('launcher default stream keeps the concurrency line on fd 2 and out of fd 1', () => {
  const env = { ...process.env };
  delete env[TEST_CONCURRENCY_ENV];
  // Start an independent runner instead of inheriting this test worker's context.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    'scripts/test/run-battery.mjs', '--test', 'src/test-roster.test.ts',
  ], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^test-concurrency: [1-9][0-9]* \([1-9][0-9]* cores\)$/m);
  assert.doesNotMatch(result.stdout, /test-concurrency/);
});

test('launcher exits non-zero when its child exits by signal', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process';
    import { runBattery } from './scripts/test/run-battery.mjs';
    process.exitCode = runBattery(['--test', 'unused.test.mjs'], {
      spawnSync: () => spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']),
    });
  `], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 });

  assert.equal(result.status, 1, result.stderr);
});

test('available core count falls back to cpu count when availableParallelism is missing', () => {
  assert.equal(availableCoreCount({ cpus: () => Array.from({ length: 4 }) }), 4);
});

test('launcher forwards the complete explicit roster exactly once', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const tokens = packageJson.scripts.test.trim().split(/\s+/);
  const testFlagIndex = tokens.indexOf('--test');
  assert.notEqual(testFlagIndex, -1);
  const roster = tokens.slice(testFlagIndex + 1);

  const plan = buildTestRunnerArgs(tokens, 18);
  assert.deepEqual(plan.roster, roster);
  assert.equal(plan.roster.length, roster.length);
  assert.equal(plan.args.slice(plan.args.indexOf('--test') + 1).length, roster.length);
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--test') + 1), roster);
});

test('launcher logs the selected concurrency once and forwards it to the child runner', () => {
  const writes = [];
  const calls = [];
  const status = runBattery(['--test', 'src/example.test.ts'], {
    osApi: { availableParallelism: () => 18, cpus: os.cpus },
    envValue: '7',
    stderr: { write: (line) => writes.push(line) },
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(writes, ['test-concurrency: 7 (18 cores)\n']);
  assert.equal(writes.filter((line) => line.startsWith('test-concurrency:')).length, 1);
  assert.deepEqual(calls[0]?.[1], ['--import', 'tsx', '--test-concurrency=7', '--test', 'src/example.test.ts']);
  assert.deepEqual(calls[0]?.[2], { stdio: 'inherit' });
  assert.equal(TEST_CONCURRENCY_ENV, 'REPLAYTEST_TEST_CONCURRENCY');
});

test('launcher announces the longest test only when that file is in the roster and on disk', () => withAmbientLauncherOverrides(() => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const tokens = packageJson.scripts.test.trim().split(/\s+/);
  // A notice about a file the battery does not run, or no longer has, would be worse than silence.
  // The development tree carries the file and rosters it; a published checkout carries neither.
  const present = fs.existsSync(path.join(REPO_ROOT, LONGEST_TEST_PATH));
  assert.equal(tokens.includes(LONGEST_TEST_PATH), present, 'the announced file must be in the repository roster exactly when it exists');
  if (fs.existsSync(DEV_TREE_MARKER)) assert.ok(present, 'the development tree must still carry the announced file');
  // Each announcement must be true of the mode it describes: seconds by default, the
  // long leg only when the full corpus was asked for.
  assert.match(longestTestNotice('full'), new RegExp(`longest test .* about ${FULL_CORPUS_LEG_MINUTES} minutes`));
  assert.match(longestTestNotice(undefined), /trimmed corpus — seconds/);
  assert.doesNotMatch(longestTestNotice(undefined), /longest test/);

  const announced = [];
  runBattery(['--test', LONGEST_TEST_PATH, 'src/example.test.ts'], {
    osApi: { availableParallelism: () => 18, cpus: os.cpus },
    envValue: '', // Explicit empty value blocks the ambient concurrency override.
    fileExists: () => true,
    corpusMode: '', // explicit: `undefined` would let the default parameter read the ambient env, so a full-corpus battery would flip this case
    stderr: { write: (line) => announced.push(line) },
    spawnSync: () => ({ status: 0 }),
  });
  assert.deepEqual(announced, ['test-concurrency: 6 (18 cores)\n', longestTestNotice(undefined)]);

  const fullCorpus = [];
  runBattery(['--test', LONGEST_TEST_PATH], {
    osApi: { availableParallelism: () => 18, cpus: os.cpus },
    envValue: '', // Explicit empty value blocks the ambient concurrency override.
    fileExists: () => true,
    corpusMode: 'full',
    stderr: { write: (line) => fullCorpus.push(line) },
    spawnSync: () => ({ status: 0 }),
  });
  assert.deepEqual(fullCorpus, ['test-concurrency: 6 (18 cores)\n', longestTestNotice('full')]);

  const quiet = [];
  runBattery(['--test', 'src/example.test.ts'], {
    osApi: { availableParallelism: () => 18, cpus: os.cpus },
    envValue: '', // Explicit empty value blocks the ambient concurrency override.
    corpusMode: '',
    stderr: { write: (line) => quiet.push(line) },
    spawnSync: () => ({ status: 0 }),
  });
  assert.deepEqual(quiet, ['test-concurrency: 6 (18 cores)\n']);

  // A roster that names the file in a checkout that does not carry it stays quiet.
  const absent = [];
  runBattery(['--test', LONGEST_TEST_PATH, 'src/example.test.ts'], {
    osApi: { availableParallelism: () => 18, cpus: os.cpus },
    envValue: '', // Explicit empty value blocks the ambient concurrency override.
    fileExists: () => false,
    corpusMode: '',
    stderr: { write: (line) => absent.push(line) },
    spawnSync: () => ({ status: 0 }),
  });
  assert.deepEqual(absent, ['test-concurrency: 6 (18 cores)\n']);
}));

test('the full-corpus duration figure is one number across the launcher, the test and the doc', (t) => {
  // Three sites quoted the same measurement and could drift apart silently.
  assert.equal(CORPUS_MODE_ENV, 'REPLAYTEST_ISOLATION_CORPUS');
  // The doc and the isolation test are dev-tree-only inputs: the published repository carries
  // neither, so each check applies only where its file exists and is reported as skipped
  // elsewhere.
  const DOC_FILE = 'docs/BATTERY-CONCURRENCY.md';
  const files = [];
  if (fs.existsSync(path.join(REPO_ROOT, LONGEST_TEST_PATH))) {
    files.push(LONGEST_TEST_PATH);
  } else {
    t.diagnostic(`skipped: ${LONGEST_TEST_PATH} is not included in the published repository`);
  }
  if (fs.existsSync(DEV_TREE_MARKER)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, DOC_FILE)), `on the full dev tree ${DOC_FILE} must exist`);
    files.push(DOC_FILE);
  } else {
    t.diagnostic(`skipped: ${DOC_FILE} is not included in the published repository`);
  }
  for (const file of files) {
    const raw = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    // Whitespace is normalised first: the doc wraps one of its quotations across a line
    // break (`**about 21\nminutes**`), which a raw match reads straight past. And EVERY
    // site the file quotes must carry the launcher's number — matching one site would
    // leave a second site free to drift on its own, silently contradicting the first.
    const quotedMinutes = [...raw.replace(/\s+/gu, ' ').matchAll(/about (\d+) minutes/gu)].map((match) => Number(match[1]));
    assert.ok(quotedMinutes.length > 0, `${file} must quote the full-corpus duration`);
    assert.deepEqual(
      [...new Set(quotedMinutes)],
      [FULL_CORPUS_LEG_MINUTES],
      `${file} must quote the same full-corpus duration as the launcher at every site, and quotes ${JSON.stringify(quotedMinutes)}`,
    );
    assert.ok(raw.includes(CORPUS_MODE_ENV), `${file} must name the corpus-mode variable`);
  }
});

test('low-core launcher keeps the first stderr line byte-identical and pins its second-line reason', () => withAmbientLauncherOverrides(() => {
  const writes = [];
  const status = runBattery(['--test', 'src/example.test.ts'], {
    osApi: { availableParallelism: () => 2, cpus: os.cpus },
    envValue: '', // Explicit empty value blocks the ambient concurrency override.
    corpusMode: '',
    stderr: { write: (line) => writes.push(line) },
    spawnSync: () => ({ status: 0 }),
  });

  assert.equal(status, 0);
  assert.deepEqual(writes, [
    'test-concurrency: 1 (2 cores)\n',
    'battery: <=3 cores → serial file execution; REPLAYTEST_TEST_CONCURRENCY=<n> overrides the file concurrency\n',
  ]);
  assert.equal(writes.filter((line) => line.startsWith('test-concurrency:')).length, 1);
  assert.doesNotMatch(writes[1], /^test-concurrency/);
  // The reason line says the useful thing itself: it names the override and points at no document.
  assert.doesNotMatch(writes[1], /guide|instructions|playbook/i);
  assert.ok(writes[1].includes(`${TEST_CONCURRENCY_ENV}=<n>`));
}));
