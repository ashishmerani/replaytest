/**
 * Direct unit tests for `scaffold`. Every filesystem artifact is contained in
 * an OS temp directory, so no live `.replaytest/**` data is touched.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildVerbHelpText, runScaffold } from './cli.js';
import { CHILD_BOOT_BUDGET_MS, replaceLease } from './cli/verbs/test-support.js';
import { renderPlanMarkdown, renderScaffoldSpec, type Sidecar } from './sidecar.js';
import { checkSpecHandEdits, readSpecEmittedHashes, resolvePlanDrift, specEmittedHashesPath } from './spec-emitted-hashes.js';
import { STATE_LOCK_WAIT_ENV, stateLockPath } from './state-lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mkTempRoot(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-scaffold-'));
}

function dirs(t: TestContext, root = mkTempRoot(t)): { root: string; plansDir: string; generatedTestsDir: string } {
  return {
    root,
    plansDir: path.join(root, '.replaytest', 'plans'),
    generatedTestsDir: path.join(root, 'tests', 'generated'),
  };
}

function sidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: 1,
    title: 'Checkout confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: '/cart > /checkout > /confirmation',
      generatedAt: '2026-08-10T12:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/cart',
    steps: [{ action: 'click', label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
    ...overrides,
  };
}

function writeSidecar(plansDir: string, slug: string, value = sidecar()): void {
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runWithCleanExitCode(run: () => void): number | undefined {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    run();
    return process.exitCode;
  } finally {
    process.exitCode = priorExitCode;
  }
}

function startStateLockHolder(stateDir: string, verb: 'heal' | 'retire', holdMs: number, releasePath: string): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const readyPath = path.join(stateDir, '.holder-ready');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, ${JSON.stringify(verb)}, { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, stateDir, readyPath, releasePath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { child, readyPath, releasePath, stderr };
}

function waitForStateLock(stateDir: string, readyPath: string): void {
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10; attempt += 1) {
    if (fs.existsSync(readyPath) && fs.existsSync(stateLockPath(stateDir))) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${stateLockPath(stateDir)}`);
}

async function waitForStateLockHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

test('runScaffold: --help prints scaffold help and writes nothing', (t: TestContext) => {
  const { plansDir, generatedTestsDir } = dirs(t);
  const lines: string[] = [];

  const exitCode = runWithCleanExitCode(() =>
    runScaffold(['--help'], { plansDir, generatedTestsDir, log: (line) => lines.push(line) }),
  );

  assert.deepEqual(lines, [buildVerbHelpText('scaffold')]);
  assert.equal(exitCode, undefined);
  assert.equal(fs.existsSync(plansDir), false);
  assert.equal(fs.existsSync(generatedTestsDir), false);
});

test('runScaffold: missing sidecar prints the refusal and exits non-zero', (t: TestContext) => {
  const { plansDir, generatedTestsDir } = dirs(t);
  const lines: string[] = [];

  const exitCode = runWithCleanExitCode(() =>
    runScaffold(['missing-flow'], { plansDir, generatedTestsDir, log: (line) => lines.push(line) }),
  );

  assert.deepEqual(lines, ['No plan found for "missing-flow" — run: replaytest plan <distinctId>.']);
  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(generatedTestsDir), false);
});

test('runScaffold: refuses an existing default spec without overwriting it', (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = dirs(t);
  const slug = 'existing-flow';
  writeSidecar(plansDir, slug);
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  fs.writeFileSync(specPath, '// finished by the user\n', 'utf8');
  const lines: string[] = [];

  const exitCode = runWithCleanExitCode(() =>
    runScaffold([slug], { plansDir, generatedTestsDir, workspaceRoot: root, specEmittedHashesPath: specEmittedHashesPath(root), log: (line) => lines.push(line) }),
  );

  assert.deepEqual(lines, [
    'tests/generated/existing-flow.spec.ts already exists — refusing to overwrite a finished test.\n  Pass --force to overwrite it, or --out <path> to write a new file to diff.',
  ]);
  assert.equal(exitCode, 1);
  assert.equal(fs.readFileSync(specPath, 'utf8'), '// finished by the user\n');
});

test('runScaffold: writes the rendered spec and plan, then reports both artifacts and the frames tip', (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = dirs(t);
  const slug = 'checkout-confirmation';
  const fixture = sidecar();
  writeSidecar(plansDir, slug, fixture);
  const lines: string[] = [];

  const exitCode = runWithCleanExitCode(() =>
    runScaffold([slug], { plansDir, generatedTestsDir, workspaceRoot: root, specEmittedHashesPath: specEmittedHashesPath(root), log: (line) => lines.push(line) }),
  );

  assert.equal(exitCode, undefined);
  assert.equal(
    fs.readFileSync(path.join(generatedTestsDir, `${slug}.spec.ts`), 'utf8'),
    renderScaffoldSpec(fixture, slug),
  );
  assert.equal(fs.readFileSync(path.join(plansDir, `${slug}.md`), 'utf8'), `${renderPlanMarkdown(fixture)}\n`);
  assert.deepEqual(lines, [
    'Wrote tests/generated/checkout-confirmation.spec.ts',
    'Wrote .replaytest/plans/checkout-confirmation.md',
    'Tip: replaytest frames checkout-confirmation — per-step DOM + screenshots for your coding agent (recordings expire; run it early).',
  ]);
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  assert.equal(checkSpecHandEdits(specEmittedHashesPath(root), root, slug, specPath).status, 'stamped-clean');
  assert.equal(resolvePlanDrift({
    slug,
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath: specEmittedHashesPath(root),
  }).verdict, 'current');
});

test('runScaffold refuses a retire-held shared lease before spec or hash publication', async (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = dirs(t);
  const slug = 'held-scaffold';
  writeSidecar(plansDir, slug);
  const stateDir = path.join(root, '.replaytest', 'state');
  const holder = startStateLockHolder(stateDir, 'retire', CHILD_BOOT_BUDGET_MS, path.join(root, '.holder-release'));
  const priorWait = process.env[STATE_LOCK_WAIT_ENV];
  const lines: string[] = [];
  try {
    waitForStateLock(stateDir, holder.readyPath);
    process.env[STATE_LOCK_WAIT_ENV] = '0';
    const exitCode = runWithCleanExitCode(() =>
      runScaffold([slug], {
        plansDir,
        generatedTestsDir,
        workspaceRoot: root,
        specEmittedHashesPath: specEmittedHashesPath(root),
        log: (line) => lines.push(line),
      }),
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(lines, [
      `state-lock-held: scaffold refused because another state-writing operation owns ${stateLockPath(stateDir)}. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.`,
    ]);
    assert.equal(fs.existsSync(path.join(generatedTestsDir, `${slug}.spec.ts`)), false);
    assert.equal(fs.existsSync(specEmittedHashesPath(root)), false);
  } finally {
    if (priorWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = priorWait;
    const holderExit = waitForStateLockHolder(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
});

test('scaffold fenced-state: a replaced lease produces exact refusal bytes on the log channel and exit 1', (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = dirs(t);
  const slug = 'fenced-scaffold';
  writeSidecar(plansDir, slug);
  const output: string[] = [];
  const exitCode = runWithCleanExitCode(() =>
    runScaffold([slug], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      specEmittedHashesPath: specEmittedHashesPath(root),
      log: (line) => output.push(line),
      onAcquired: replaceLease,
    }),
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(output, ['state-lock-fenced: scaffold stopped before publishing because another command took over the shared write lock. Re-run scaffold.']);
});

test('scaffold generic IO: malformed sidecar keeps its exact refusal bytes on the log channel and exits 1', (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = dirs(t);
  const slug = 'io-scaffold';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), 'not-json', 'utf8');
  const lines: string[] = [];

  const exitCode = runWithCleanExitCode(() =>
    runScaffold([slug], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      specEmittedHashesPath: specEmittedHashesPath(root),
      log: (line) => lines.push(line),
    }),
  );

  assert.deepEqual(lines, [
    `Could not scaffold "${slug}": Unexpected token 'o', "not-json" is not valid JSON`,
  ]);
  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(path.join(generatedTestsDir, `${slug}.spec.ts`)), false);
});

test('runScaffold: --out writes the rendered spec to the override path', (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = dirs(t);
  const slug = 'custom-output';
  const fixture = sidecar({ title: 'Custom output' });
  writeSidecar(plansDir, slug, fixture);
  const outPath = path.join(root, 'drafts', 'custom-output.spec.ts');
  const lines: string[] = [];

  const exitCode = runWithCleanExitCode(() =>
    runScaffold([slug, '--out', outPath], { plansDir, generatedTestsDir, workspaceRoot: root, specEmittedHashesPath: specEmittedHashesPath(root), log: (line) => lines.push(line) }),
  );

  assert.equal(exitCode, undefined);
  assert.equal(checkSpecHandEdits(specEmittedHashesPath(root), root, slug, path.join(generatedTestsDir, `${slug}.spec.ts`)).status, 'unknown');
  assert.equal(
    readSpecEmittedHashes(specEmittedHashesPath(root))?.entries.some((entry) => entry.slug === slug) ?? false,
    false,
    '--out must not create any emitted-spec marker for this slug',
  );
  assert.equal(fs.readFileSync(outPath, 'utf8'), renderScaffoldSpec(fixture, slug));
  assert.equal(fs.existsSync(path.join(generatedTestsDir, `${slug}.spec.ts`)), false);
  assert.equal(fs.readFileSync(path.join(plansDir, `${slug}.md`), 'utf8'), `${renderPlanMarkdown(fixture)}\n`);
  assert.deepEqual(lines, [
    `Wrote ${outPath}`,
    'Wrote .replaytest/plans/custom-output.md',
    'Tip: replaytest frames custom-output — per-step DOM + screenshots for your coding agent (recordings expire; run it early).',
  ]);
});
