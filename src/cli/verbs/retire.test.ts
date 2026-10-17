/**
 * Tests for the `retire` verb — the consent-gated archival verb that closes
 * the empty-search evidence loop. Covers the consent gate (override contract),
 * the evidence view, the archival sequence (retirement.json first),
 * the completion message shape, door-awareness byte-identical guarantee, and
 * the second-retire timestamp-suffixed sibling.
 *
 * Fixtures use real captured sidecar shapes with synthetic empty-search trails.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRetireArgs } from '../args.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND } from '../constants.js';
import { appendRetiredAwareness, isSlugRetired, readRetiredRecord, retiredDoorSentence } from '../retired-awareness.js';
import { trailMentionSentence } from '../../retirement-evidence.js';
import {
  collectGeneratedSuiteStatView,
  retirePlan,
  runRetire,
  type RetireOptions,
} from './retire.js';
import { acceptProposal } from '../../accept.js';
import { collectGeneratedSuiteFingerprint } from '../../heal.js';
import type { Sidecar, SidecarEmptySearch } from '../../sidecar.js';
import { writeRetireJournal, type RetireJournal } from '../../retire-journal.js';
import { acquireStateLock, releaseStateLock, STATE_LOCK_WAIT_ENV } from '../../state-lock.js';
import { stageSourceTree } from '../../staged-copy.test-support.js';
import { PRIVACY_GITIGNORE_REFUSAL_COPY, privacyGitIgnoreWarningCopy } from '../../pii-lint.js';
import { CHILD_BOOT_BUDGET_MS } from './test-support.js';
import { formatRetireRefusalJson } from '../../retire-format.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-18T12:00:00.000Z');
const SIG = '/cart > /confirmation';

test('retire --json refusal envelopes expose exactly code and message in error', () => {
  const envelope = JSON.parse(formatRetireRefusalJson({
    kind: 'refusal',
    code: 'state-lock-fenced',
    message: 'state-lock-fenced: fixture',
    exitCode: 1,
  })) as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message']);
  assert.doesNotMatch(JSON.stringify(envelope.error), /kind|exitCode/, 'a refusal envelope must not expose any internal result fields');
});

test('retire dedupes two late-release rows into one JSON warning that names both files', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  writeHashBaseline(fixture, slug);
  fs.writeFileSync(fixture.selectorAppliesPath, `${JSON.stringify([{ slug, canonicalSpecPath: `tests/generated/${slug}.spec.ts` }], null, 2)}\n`, 'utf8');
  const progress: string[] = [];

  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    progress: (line) => progress.push(line),
    afterCleanupStatePublication: (row) => {
      if (row.rowKind !== 'spec-emitted-hashes' && row.rowKind !== 'selector-applies') return;
      const replacement = acquireStateLock(path.dirname(fixture.healLatestPath), 'heal', { waitMs: 0 }, true);
      releaseStateLock(replacement);
    },
  });

  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.equal(result.warnings?.length, 1, 'one run must expose one warning per code');
  assert.deepEqual(result.warnings?.[0]?.files, [fixture.specEmittedHashesPath, fixture.selectorAppliesPath]);
  assert.equal(
    progress.filter((line) => line.includes('state-lock-released-late')).length,
    2,
    'each landed late-release disclosure remains visible on the prose channel',
  );
});

function mkTempRoot(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-retire-'));
}

/** Escapes a filesystem path for use as a literal inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RetireFixture {
  root: string;
  plansDir: string;
  generatedTestsDir: string;
  reproductionsDir: string;
  framesDir: string;
  retiredDir: string;
  specEmittedHashesPath: string;
  selectorAppliesPath: string;
  triageEvidenceDir: string;
  healLatestPath: string;
}

function mkFixture(t: TestContext): RetireFixture {
  const root = mkTempRoot(t);
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const reproductionsDir = path.join(root, 'tests', 'reproductions');
  const framesDir = path.join(root, '.replaytest', 'frames');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  const stateDir = path.join(root, '.replaytest', 'state');
  const triageEvidenceDir = path.join(root, '.replaytest', 'triage');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(reproductionsDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root,
    plansDir,
    generatedTestsDir,
    reproductionsDir,
    framesDir,
    retiredDir,
    specEmittedHashesPath: path.join(stateDir, 'spec-emitted-hashes.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    triageEvidenceDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
  };
}

function startStateLockHolder(stateDir: string, holdMs: number): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const readyPath = path.join(stateDir, '.holder-ready');
  const releasePath = path.join(stateDir, '.holder-release');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, 'heal', { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, stateDir, readyPath, releasePath], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { child, readyPath, releasePath, stderr };
}

function waitForStateLock(stateDir: string, readyPath: string): void {
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10; attempt += 1) {
    if (fs.existsSync(readyPath) && fs.existsSync(path.join(stateDir, '.state-lock'))) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${path.join(stateDir, '.state-lock')}`);
}

async function waitForHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

function sidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: 1,
    title: 'Checkout confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: SIG,
      generatedAt: '2026-07-01T12:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/cart',
    steps: [{ action: 'click', label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
    ...overrides,
  };
}

function emptySearch(
  searchedAt: string,
  sinceHours = 720,
  overrides: Partial<SidecarEmptySearch> = {},
): SidecarEmptySearch {
  return {
    searchedAt,
    sinceHours,
    scope: 'unscoped traffic',
    signature: SIG,
    signatureSource: 'sidecar',
    tierACandidates: 0,
    tierBVariants: 0,
    successorObservations: [],
    ...overrides,
  };
}

/** Two qualifying entries ≥24h apart → bar met. */
function barMetTrail(): SidecarEmptySearch[] {
  return [
    emptySearch('2026-08-10T12:00:00.000Z'),
    emptySearch('2026-08-15T12:00:00.000Z'),
  ];
}

/** One qualifying entry → bar unmet (1 of 2). */
function barUnmetTrail(): SidecarEmptySearch[] {
  return [emptySearch('2026-08-15T12:00:00.000Z')];
}

function writeLive(fixture: RetireFixture, slug: string, live: Sidecar): void {
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.md`), `# ${live.title}\n`, 'utf8');
}

/** Real parseable retire/state lock-file shapes, matching the existing lock acceptance fixtures. */
function writeRetireLock(fixture: RetireFixture, pid: number): void {
  fs.mkdirSync(fixture.retiredDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, '.retire-lock'),
    `${JSON.stringify({ pid, createdAt: '2026-08-24T00:00:00.000Z', generation: 'crashed-retire-generation' })}\n`,
    'utf8',
  );
}

function writeStateLock(fixture: RetireFixture, pid: number, createdAt = '2026-08-01T00:00:00.000Z'): void {
  fs.writeFileSync(
    path.join(path.dirname(fixture.healLatestPath), '.state-lock'),
    `${JSON.stringify({ pid, createdAt, generation: 'crashed-state-generation', verb: 'retire' })}\n`,
    'utf8',
  );
}

function publishRecoveryJournal(fixture: RetireFixture): void {
  const journal: RetireJournal = {
    schemaVersion: 1,
    status: 'in-progress',
    journalId: 'retire-privacy-recovery',
    slug: 'checkout-confirmation',
    archiveDir: '.replaytest/retired/checkout-confirmation',
    retiredAt: '2026-08-17T12:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true },
    evidenceBasis: 'operator-asserted',
    trail: [],
    successorObservations: [],
    harvestedState: { files: [] },
    artifactRows: [],
    cleanupRows: [],
    lockGeneration: 'retire-privacy-recovery-lock',
  };
  fs.mkdirSync(fixture.retiredDir, { recursive: true });
  writeRetireJournal(fixture.retiredDir, journal);
}

/** A real spec-emitted-hashes baseline carrying one entry for `slug`. */
function writeHashBaseline(fixture: RetireFixture, slug: string): void {
  fs.writeFileSync(
    fixture.specEmittedHashesPath,
    `${JSON.stringify({
      schema: 'replaytest-spec-emitted-hashes/v1',
      algorithm: 'sha256',
      entries: [{
        slug,
        specPath: `tests/generated/${slug}.spec.ts`,
        specSha256: 'a'.repeat(64),
        generatedAt: '2026-08-01T00:00:00.000Z',
      }],
    }, null, 2)}\n`,
    'utf8',
  );
}

function writeSpec(fixture: RetireFixture, slug: string): void {
  fs.writeFileSync(path.join(fixture.generatedTestsDir, `${slug}.spec.ts`), `// replaytest-slug: ${slug}\nimport { test } from '@playwright/test';\n`, 'utf8');
}

function writeDefaultRepro(fixture: RetireFixture, slug: string): void {
  fs.writeFileSync(path.join(fixture.reproductionsDir, `${slug}.repro.spec.ts`), `// default repro for ${slug}\n`, 'utf8');
}

function opts(
  fixture: RetireFixture,
  slug: string,
  flags: {
    confirmRetire?: boolean;
    noEvidence?: boolean;
    stealLock?: boolean;
    stealStateLock?: boolean;
    recoverCrashedLocks?: boolean;
    moveFile?: (source: string, destination: string) => void;
    makeArchiveDir?: (archive: string) => void;
  } = {},
): RetireOptions {
  return {
    slug,
    confirmRetire: flags.confirmRetire ?? false,
    noEvidence: flags.noEvidence ?? false,
    ...(flags.stealLock === undefined ? {} : { stealLock: flags.stealLock }),
    ...(flags.stealStateLock === undefined ? {} : { stealStateLock: flags.stealStateLock }),
    ...(flags.recoverCrashedLocks === undefined ? {} : { recoverCrashedLocks: flags.recoverCrashedLocks }),
    ...(flags.moveFile === undefined ? {} : { moveFile: flags.moveFile }),
    ...(flags.makeArchiveDir === undefined ? {} : { makeArchiveDir: flags.makeArchiveDir }),
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    reproductionsDir: fixture.reproductionsDir,
    framesDir: fixture.framesDir,
    retiredDir: fixture.retiredDir,
    workspaceRoot: fixture.root,
    specEmittedHashesPath: fixture.specEmittedHashesPath,
    selectorAppliesPath: fixture.selectorAppliesPath,
    triageEvidenceDir: fixture.triageEvidenceDir,
    healLatestPath: fixture.healLatestPath,
    now: () => NOW,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('parseRetireArgs: no args → no slug, all flags false', () => {
  const args = parseRetireArgs([]);
  assert.equal(args.slug, undefined);
  assert.equal(args.confirmRetire, false);
  assert.equal(args.noEvidence, false);
  assert.equal(args.recoverCrashedLocks, false);
  assert.equal(args.json, false);
});

test('parseRetireArgs: --recover-crashed-locks is one recognized consent flag', () => {
  const args = parseRetireArgs(['checkout-confirmation', '--recover-crashed-locks']);
  assert.equal(args.recoverCrashedLocks, true);
  assert.equal('unknownFlag' in args, false);
});

test('parseRetireArgs: slug + both consent flags + json', () => {
  const args = parseRetireArgs(['checkout-confirmation', '--confirm-retire', '--no-evidence', '--json']);
  assert.equal(args.slug, 'checkout-confirmation');
  assert.equal(args.confirmRetire, true);
  assert.equal(args.noEvidence, true);
  assert.equal(args.json, true);
});

test('parseRetireArgs: long unknown flags are left to the shared validator', () => {
  const args = parseRetireArgs(['slug', '--bogus']);
  assert.equal('unknownFlag' in args, false);
});

test('parseRetireArgs: single-dash tokens are left to downstream parsing', () => {
  const args = parseRetireArgs(['slug', '-x']);
  assert.equal('unknownFlag' in args, false);
});

test('retirePlan: both dead locks recover with the single flag exactly as the granular triple does', (t: TestContext) => {
  const single = mkFixture(t);
  const granular = mkFixture(t);
  const slug = 'checkout-confirmation';
  for (const fixture of [single, granular]) {
    writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
    writeRetireLock(fixture, 99_999_999);
    writeStateLock(fixture, 99_999_999);
  }

  const singleResult = retirePlan(opts(single, slug, { recoverCrashedLocks: true }));
  const granularResult = retirePlan(opts(granular, slug, { confirmRetire: true, stealLock: true, stealStateLock: true }));
  assert.equal(singleResult.kind, 'retired');
  assert.equal(granularResult.kind, 'retired');
  if (singleResult.kind !== 'retired' || granularResult.kind !== 'retired') return;
  assert.deepEqual(
    { evidenceBasis: singleResult.evidenceBasis, evidenceSummary: singleResult.evidenceSummary, movedArtifacts: singleResult.movedArtifacts },
    { evidenceBasis: granularResult.evidenceBasis, evidenceSummary: granularResult.evidenceSummary, movedArtifacts: granularResult.movedArtifacts },
  );
  assert.equal(fs.existsSync(path.join(single.retiredDir, '.retire-lock')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(single.healLatestPath), '.state-lock')), false);
});

test('retirePlan: --recover-crashed-locks refuses when only one lock is held and does not steal it', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeRetireLock(fixture, 99_999_999);
  const retireLockPath = path.join(fixture.retiredDir, '.retire-lock');
  const before = fs.readFileSync(retireLockPath, 'utf8');

  const result = retirePlan(opts(fixture, slug, { recoverCrashedLocks: true }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'retirement-lock-held');
  assert.match(result.message, /--confirm-retire --steal-lock/);
  assert.equal(fs.readFileSync(retireLockPath, 'utf8'), before, 'one-lock refusal must not partially steal the retire lock');
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.plan.json`)), true, 'one-lock refusal must not start retirement');
});

test('retirePlan: --recover-crashed-locks refuses an alive owner without partially stealing the dead lock', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeRetireLock(fixture, 99_999_999);
  writeStateLock(fixture, process.pid);
  const retireLockPath = path.join(fixture.retiredDir, '.retire-lock');
  const before = fs.readFileSync(retireLockPath, 'utf8');

  const result = retirePlan(opts(fixture, slug, { recoverCrashedLocks: true }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'state-lock-held');
  assert.match(result.message, /another state-writing operation owns/);
  assert.equal(fs.readFileSync(retireLockPath, 'utf8'), before, 'alive-owner refusal must not partially steal the dead retire lock');
});

test('retirePlan: --recover-crashed-locks refuses a live retire-lock owner and preserves its bytes', async (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  assert.ok(holder.pid !== undefined, 'the real retire-lock holder must expose its pid');
  try {
    writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
    writeRetireLock(fixture, holder.pid);
    writeStateLock(fixture, 99_999_999);
    const retireLockPath = path.join(fixture.retiredDir, '.retire-lock');
    const before = fs.readFileSync(retireLockPath, 'utf8');

    const result = retirePlan(opts(fixture, slug, { recoverCrashedLocks: true }));
    assert.equal(result.kind, 'refusal');
    if (result.kind !== 'refusal') return;
    assert.equal(result.code, 'retirement-lock-held');
    assert.equal(fs.readFileSync(retireLockPath, 'utf8'), before, 'live retire-owner refusal must preserve the lock byte-for-byte');
    assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.plan.json`)), true, 'live retire-owner refusal must not start retirement');
  } finally {
    holder.kill();
    await waitForHolder(holder);
  }
});

test('retirePlan: --recover-crashed-locks honors the state-lock recovery grace window', (t: TestContext) => {
  const slug = 'checkout-confirmation';
  const withinGrace = mkFixture(t);
  writeLive(withinGrace, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeRetireLock(withinGrace, 99_999_999);
  writeStateLock(withinGrace, 99_999_999, NOW.toISOString());
  const withinGraceResult = retirePlan({ ...opts(withinGrace, slug, { recoverCrashedLocks: true }), stateLockOptions: { graceMs: 5_000, waitMs: 0 } });
  assert.equal(withinGraceResult.kind, 'refusal');
  if (withinGraceResult.kind !== 'refusal') return;
  assert.equal(withinGraceResult.code, 'state-lock-held');
  assert.match(withinGraceResult.message, /the dead state-lock holder at .* is still inside its recovery grace window\. Retry after the grace window/);
  assert.match(withinGraceResult.message, /only when you accept that the dead holder's in-flight write may still land over recent state/);
  assert.doesNotMatch(withinGraceResult.message, /a live holder may still land one in-flight write/);
  assert.doesNotMatch(withinGraceResult.message, /another state-writing operation owns/, 'a dead in-grace holder must never be narrated as a live owner');

  const granular = retirePlan({ ...opts(withinGrace, slug, { confirmRetire: true, stealLock: true }), stateLockOptions: { graceMs: 5_000, waitMs: 0 } });
  assert.equal(granular.kind, 'refusal', 'the equivalent granular attempt without --steal-state-lock also refuses inside grace');
  if (granular.kind === 'refusal') assert.equal(granular.code, 'state-lock-held');

  const pastGrace = mkFixture(t);
  writeLive(pastGrace, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeRetireLock(pastGrace, 99_999_999);
  writeStateLock(pastGrace, 99_999_999, NOW.toISOString());
  const pastGraceResult = retirePlan({
    ...opts(pastGrace, slug, { recoverCrashedLocks: true }),
    now: () => new Date(NOW.getTime() + 5_001),
    stateLockOptions: { graceMs: 5_000, waitMs: 0 },
  });
  assert.equal(pastGraceResult.kind, 'retired');
});

test('retirePlan: granular recovery is listed first when the state lock is malformed', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeRetireLock(fixture, 99_999_999);
  fs.writeFileSync(path.join(path.dirname(fixture.healLatestPath), '.state-lock'), 'malformed-state-lock\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { recoverCrashedLocks: true }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  const granularCommand = `replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock`;
  assert.ok(result.message.indexOf(granularCommand) >= 0);
  assert.match(result.message, /single --recover-crashed-locks flag does not apply because the state lock is malformed/);
  assert.ok(result.message.indexOf(granularCommand) < result.message.indexOf('--recover-crashed-locks'), 'the working granular form must be printed first');
});

test('retirePlan: crashed-both-locks refusal prints the exact single-flag command before the granular form', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  publishRecoveryJournal(fixture);
  writeRetireLock(fixture, 99_999_999);
  writeStateLock(fixture, 99_999_999);

  const result = retirePlan(opts(fixture, slug));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  const singleCommand = `replaytest retire ${slug} --recover-crashed-locks`;
  const granularCommand = `replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock`;
  assert.equal(result.message.split(singleCommand).length - 1, 1, 'the exact single-flag recovery command appears once');
  assert.equal(result.message.split(granularCommand).length - 1, 1, 'the granular recovery form remains documented once');
  assert.doesNotMatch(result.message, /\{\{slug\}\}|<slug>/, 'customer recovery copy must render the real slug, never expose an interpolation marker');
  assert.ok(result.message.indexOf(singleCommand) < result.message.indexOf(granularCommand), 'the single flag is the first recovery option');

  const stealAlone = retirePlan(opts(fixture, slug, { stealLock: true }));
  assert.equal(stealAlone.kind, 'refusal');
  if (stealAlone.kind !== 'refusal') return;
  assert.equal(stealAlone.message.split(singleCommand).length - 1, 1, '--steal-lock-alone guidance names the exact single-flag command once');
  assert.equal(stealAlone.message.split(granularCommand).length - 1, 1, '--steal-lock-alone guidance retains the granular form once');
  assert.ok(stealAlone.message.indexOf(singleCommand) < stealAlone.message.indexOf(granularCommand));
});

test('retirePlan: --recover-crashed-locks refuses when neither required lock is held', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  const result = retirePlan(opts(fixture, slug, { recoverCrashedLocks: true }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'retirement-recovery-required');
  assert.match(result.message, /requires both the retire lock and shared state lock to be held by dead owners/);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('retirePlan: no live plan and not retired → no-plan refusal', (t: TestContext) => {
  const fixture = mkFixture(t);
  const result = retirePlan(opts(fixture, 'missing-slug'));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'no-plan');
  assert.match(result.message, /No live plan found for "missing-slug"/);
  assert.match(result.message, /replaytest plan/);
});

test('retirePlan: no live plan but retired folder exists → already-retired refusal names the record', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  fs.mkdirSync(path.join(fixture.retiredDir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, slug, 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', consentFlags: { confirmRetire: true, noEvidence: false }, evidenceBasis: 'empty-search-trail', trail: [], successorObservations: [], harvestedState: {}, artifactManifest: [], reversalRecipe: [] }, null, 2)}\n`,
    'utf8',
  );

  const result = retirePlan(opts(fixture, slug));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'already-retired');
  assert.match(result.message, /retired on/i);
  assert.match(result.message, /retirement\.json/);
});

test('retirePlan: --confirm-retire alone with bar unmet → refuses, names --no-evidence door', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barUnmetTrail() } }));
  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'confirm-requires-bar-or-no-evidence');
  assert.match(result.message, /evidence bar is not met/);
  assert.match(result.message, /--confirm-retire --no-evidence/);
});

test('retirePlan: recovery refuses before resuming a tracked archive when the destination is not ignored', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  publishRecoveryJournal(fixture);
  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    privacyGitIgnoreCheck: () => ({
      status: 'not-ignored',
      warning: 'privacy-workspace-not-ignored: .replaytest/retired/ is not git-ignored; local privacy state may be committed. Add .replaytest/retired/ to .gitignore before continuing.',
      code: 'privacy-workspace-not-ignored',
    }),
  });
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'privacy-workspace-not-ignored');
  assert.equal(result.message, PRIVACY_GITIGNORE_REFUSAL_COPY);
  assert.doesNotMatch(result.message, /this artifact contains PII-shaped data/i);
});

test('retirePlan: fresh archive logs the not-ignored warning when disclosure consent is explicit', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  const logs: string[] = [];
  const progress: string[] = [];
  const warning = privacyGitIgnoreWarningCopy('.replaytest/retired/');
  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    allowPrivacyDisclosure: true,
    log: (line) => logs.push(line),
    progress: (line) => progress.push(line),
    privacyGitIgnoreCheck: () => ({ status: 'not-ignored', warning, code: 'privacy-workspace-not-ignored' }),
  });
  assert.equal(result.kind, 'retired');
  assert.deepEqual(logs, []);
  assert.deepEqual(progress, [`[privacy-workspace-not-ignored] ${warning}`]);
});

test('retirePlan: resumed archive logs the not-ignored warning when disclosure consent is explicit', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  publishRecoveryJournal(fixture);
  const logs: string[] = [];
  const progress: string[] = [];
  const warning = privacyGitIgnoreWarningCopy('.replaytest/retired/');
  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    allowPrivacyDisclosure: true,
    log: (line) => logs.push(line),
    progress: (line) => progress.push(line),
    privacyGitIgnoreCheck: () => ({ status: 'not-ignored', warning, code: 'privacy-workspace-not-ignored' }),
  });
  assert.equal(result.kind, 'retired');
  assert.deepEqual(logs, []);
  assert.deepEqual(progress, [`[privacy-workspace-not-ignored] ${warning}`]);
});

test('retire --json keeps the non-git probe note on stderr and stdout parseable', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'json-nongit';
  writeLive(fixture, slug, sidecar());
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--no-evidence', '--json'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1, 'non-git JSON stdout must contain one envelope only');
    assert.equal((JSON.parse(stdout[0] ?? '{}') as { retired?: { kind?: string } }).retired?.kind, 'retired');
    assert.deepEqual(stderr, ['[privacy-workspace-probe-skipped] privacy-workspace-probe-skipped: could not determine whether the destination is covered by Git ignore rules; continuing without the best-effort check.']);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('resumed retire --json also keeps the non-git probe note on stderr', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  publishRecoveryJournal(fixture);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--json'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1, 'resumed non-git JSON stdout must contain one envelope only');
    assert.equal((JSON.parse(stdout[0] ?? '{}') as { retired?: { kind?: string } }).retired?.kind, 'retired');
    assert.deepEqual(stderr, ['[privacy-workspace-probe-skipped] privacy-workspace-probe-skipped: could not determine whether the destination is covered by Git ignore rules; continuing without the best-effort check.']);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('temp-sweep prose never shares the --json stdout envelope', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'json-sweep-prose';
  writeLive(fixture, slug, sidecar());
  fs.mkdirSync(fixture.retiredDir, { recursive: true });
  // A stray old-format lock claim makes sweepNormalPathTemps emit its "left an old-format lock file" line.
  fs.writeFileSync(path.join(fixture.retiredDir, '.retire-lock.claim-legacy'), 'legacy', 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--no-evidence', '--json'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1, 'sweep prose must not share the --json stdout envelope');
    assert.equal((JSON.parse(stdout[0] ?? '{}') as { retired?: { kind?: string } }).retired?.kind, 'retired');
    assert.ok(stderr.some((line) => line.includes('left an old-format lock file from a previous version in place: .retire-lock.claim-legacy')), 'the sweep line still reaches the human/progress channel');
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('the production progress default is console.error, so --json stdout stays pure without an injected progress sink', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'json-default-progress';
  writeLive(fixture, slug, sidecar());
  const stdout: string[] = [];
  const consoleErrorLines: string[] = [];
  const previousExitCode = process.exitCode;
  const previousConsoleError = console.error;
  try {
    process.exitCode = undefined;
    console.error = (...parts: unknown[]) => { consoleErrorLines.push(parts.map(String).join(' ')); };
    runRetire([slug, '--confirm-retire', '--no-evidence', '--json'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      // deliberately NO progress sink: the production default must route the probe note to console.error
    });
    assert.equal(stdout.length, 1, 'with the production progress default, --json stdout must contain one envelope only');
    assert.equal((JSON.parse(stdout[0] ?? '{}') as { retired?: { kind?: string } }).retired?.kind, 'retired');
    assert.ok(consoleErrorLines.some((line) => line.startsWith('[privacy-workspace-probe-skipped] privacy-workspace-probe-skipped:')), 'the probe note must reach console.error by default');
  } finally {
    console.error = previousConsoleError;
    process.exitCode = previousExitCode;
  }
});

test('retire --json keeps the established-repository warning on stderr after consent', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'json-unignored';
  writeLive(fixture, slug, sidecar());
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: fixture.root }).status, 0);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--no-evidence', '--allow-privacy-disclosure', '--json'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1, 'consented JSON stdout must contain one envelope only');
    assert.equal((JSON.parse(stdout[0] ?? '{}') as { retired?: { kind?: string } }).retired?.kind, 'retired');
    assert.deepEqual(stderr, [`[privacy-workspace-not-ignored] ${privacyGitIgnoreWarningCopy('.replaytest/retired/')}`]);
    assert.doesNotMatch(stderr[0] ?? '', /\.replaytest\/ is/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('an uncovered retirement destination has its own refusal code and JSON copy', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'json-refusal-unignored';
  writeLive(fixture, slug, sidecar());
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: fixture.root }).status, 0);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--no-evidence', '--json'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1);
    const envelope = JSON.parse(stdout[0] ?? '{}') as { error?: { code?: string; message?: string } };
    assert.equal(envelope.error?.code, 'privacy-workspace-not-ignored');
    assert.equal(envelope.error?.message, PRIVACY_GITIGNORE_REFUSAL_COPY);
    assert.doesNotMatch(envelope.error?.message ?? '', /this artifact contains PII-shaped data/i);
    assert.deepEqual(stderr, []);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('human retire still displays the non-git probe note', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'human-nongit';
  writeLive(fixture, slug, sidecar());
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--no-evidence'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1);
    assert.match(stdout[0] ?? '', /Retired human-nongit/);
    assert.match(stderr[0] ?? '', /privacy-workspace-probe-skipped/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('retirePlan: --no-evidence alone → refuses, names --confirm-retire', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar());
  const result = retirePlan(opts(fixture, slug, { noEvidence: true }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'no-evidence-requires-confirm');
  assert.match(result.message, /--no-evidence requires --confirm-retire/);
});

// ---------------------------------------------------------------------------
// Evidence view (read-only)
// ---------------------------------------------------------------------------

test('retirePlan: no flags with bar unmet → evidence view, names the gap and the consent command', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barUnmetTrail() } }));
  const result = retirePlan(opts(fixture, slug));
  assert.equal(result.kind, 'evidence-view');
  if (result.kind !== 'evidence-view') return;
  assert.equal(result.status.met, false);
  assert.match(result.message, /evidence bar is not yet met/);
  assert.match(result.message, /replaytest regenerate/);
  assert.match(result.message, /--confirm-retire --no-evidence/);
});

test('retirePlan: no flags with bar met → evidence view, names the consent command', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  const result = retirePlan(opts(fixture, slug));
  assert.equal(result.kind, 'evidence-view');
  if (result.kind !== 'evidence-view') return;
  assert.equal(result.status.met, true);
  assert.match(result.message, /evidence bar is met/);
  assert.match(result.message, /replaytest retire .* --confirm-retire/);
});

test('retirePlan: evidence view carries the Tier-1 rail — never asserts extinction', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  const result = retirePlan(opts(fixture, slug));
  if (result.kind !== 'evidence-view') return;
  const banned = ['gone', 'extinct', 'no longer exists', 'disappeared', 'dead', 'retired because'];
  for (const word of banned) {
    assert.equal(result.message.toLowerCase().includes(word), false, `evidence view must not use banned Tier-1 vocabulary "${word}"`);
  }
});

// ---------------------------------------------------------------------------
// Archival: normal path (bar met)
// ---------------------------------------------------------------------------

test('retirePlan: --confirm-retire with bar met → retires, writes retirement.json, moves artifacts', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.equal(result.slug, slug);
  assert.equal(result.evidenceBasis, 'empty-search-trail');

  // retirement.json exists in the archive
  const archiveDir = path.join(fixture.retiredDir, slug);
  assert.equal(fs.existsSync(path.join(archiveDir, 'retirement.json')), true);

  // Plan + spec moved into the archive
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'tests', `${slug}.spec.ts`)), true);

  // Live plan + spec are gone
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.plan.json`)), false);
  assert.equal(fs.existsSync(path.join(fixture.generatedTestsDir, `${slug}.spec.ts`)), false);

  // No default-path repro means the completion copy is byte-identical to the
  // pre-repro-archival wording: no repro clause and no changed separator.
  assert.equal(
    result.completionMessage,
    'Retired checkout-confirmation (archive: .replaytest/retired/checkout-confirmation/). Evidence: 2 empty searches over 720h between 2026-08-10T12:00:00.000Z and 2026-08-15T12:00:00.000Z; no plannable candidate was witnessed. Keep the archive folder local to preserve the record. Restore recipe: retirement.json. Note: this tool cannot detect a write that lands at the exact moment of archiving, and if something else deletes files at the same time, the results can look like this tool\'s own partial work.',
  );

  const record = JSON.parse(fs.readFileSync(path.join(archiveDir, 'retirement.json'), 'utf8')) as {
    artifactManifest: Array<{ from: string; to: string }>;
  };
  assert.equal(record.artifactManifest.some((entry) => entry.from.includes('/reproductions/')), false, 'an absent default repro must not create a phantom manifest row');
});

test('retirePlan: moves only the default-path repro, records it, and leaves --out repros untouched', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  writeDefaultRepro(fixture, slug);
  const outRepro = path.join(fixture.root, 'customer-repros', `${slug}.custom.repro.spec.ts`);
  fs.mkdirSync(path.dirname(outRepro), { recursive: true });
  fs.writeFileSync(outRepro, '// customer --out repro\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;

  const archivedRepro = path.join(fixture.retiredDir, slug, 'reproductions', `${slug}.repro.spec.ts`);
  assert.equal(fs.existsSync(archivedRepro), true);
  assert.equal(fs.existsSync(path.join(fixture.reproductionsDir, `${slug}.repro.spec.ts`)), false);
  assert.equal(fs.existsSync(outRepro), true, 'a repro written with --out has no slug-derived ownership association');
  assert.ok(result.movedArtifacts.includes(path.relative(fixture.root, archivedRepro)));
  assert.equal(
    result.completionMessage,
    'Retired checkout-confirmation (archive: .replaytest/retired/checkout-confirmation/). Evidence: 2 empty searches over 720h between 2026-08-10T12:00:00.000Z and 2026-08-15T12:00:00.000Z; no plannable candidate was witnessed. Also archived this journey\'s reproduction spec: tests/reproductions/checkout-confirmation.repro.spec.ts → .replaytest/retired/checkout-confirmation/reproductions/checkout-confirmation.repro.spec.ts. (Only the default-path repro is tracked; repros written with --out stay where you put them.) Keep the archive folder local to preserve the record. Restore recipe: retirement.json. Note: this tool cannot detect a write that lands at the exact moment of archiving, and if something else deletes files at the same time, the results can look like this tool\'s own partial work.',
  );

  const record = JSON.parse(fs.readFileSync(path.join(fixture.retiredDir, slug, 'retirement.json'), 'utf8')) as {
    artifactManifest: Array<{ from: string; to: string }>;
  };
  assert.deepEqual(
    record.artifactManifest.filter((entry) => entry.from === `tests/reproductions/${slug}.repro.spec.ts`),
    [{ from: `tests/reproductions/${slug}.repro.spec.ts`, to: `.replaytest/retired/${slug}/reproductions/${slug}.repro.spec.ts` }],
  );
});

test('retirePlan: the root journal is published BEFORE artifacts are moved (archival sequence)', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  // Intercept the move to assert the root journal already exists when moves begin.
  let journalExistedAtFirstMove = false;
  let firstMoveSeen = false;
  const moveSpy = (source: string, destination: string): void => {
    if (!firstMoveSeen) {
      firstMoveSeen = true;
      journalExistedAtFirstMove = fs.existsSync(path.join(fixture.retiredDir, `${slug}.journal.json`));
    }
    fs.renameSync(source, destination);
  };

  const result = retirePlan({ ...opts(fixture, slug, { confirmRetire: true }), moveFile: moveSpy });
  assert.equal(result.kind, 'retired');
  assert.equal(journalExistedAtFirstMove, true, 'the root journal must exist before the first artifact move');
});

test('the root journal is published before archive-directory creation', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  let journalExistedAtArchiveMkdir = false;
  const result = retirePlan(opts(fixture, slug, {
    confirmRetire: true,
    makeArchiveDir: (archive) => {
      journalExistedAtArchiveMkdir = fs.existsSync(path.join(fixture.retiredDir, `${slug}.journal.json`));
      fs.mkdirSync(archive, { recursive: true });
    },
  }));
  assert.equal(result.kind, 'retired');
  assert.equal(journalExistedAtArchiveMkdir, true, 'the root journal must be durable before archive mkdir');
});

test('a fenced writer re-reads and reports the replacement parseable lock', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  const replacement = { pid: 99999999, createdAt: '2026-08-24T00:00:00.000Z', generation: 'replacement-generation' };
  let replaced = false;
  const result = retirePlan(opts(fixture, slug, {
    confirmRetire: true,
    moveFile: (source, destination) => {
      fs.renameSync(source, destination);
      if (!replaced) {
        replaced = true;
        fs.unlinkSync(path.join(fixture.retiredDir, '.retire-lock'));
        fs.writeFileSync(path.join(fixture.retiredDir, '.retire-lock'), `${JSON.stringify(replacement)}\n`, 'utf8');
      }
    },
  }));
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'retirement-lock-held');
  assert.match(result.message, /pid 99999999/);
  assert.doesNotMatch(result.message, /unreadable lock/);
});

// ---------------------------------------------------------------------------
// Archival: override path (--confirm-retire --no-evidence)
// ---------------------------------------------------------------------------

test('retirePlan: --confirm-retire --no-evidence → retires on operator assertion, records the assertion', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  // Bar is NOT met (no trail at all)
  writeLive(fixture, slug, sidecar());
  writeSpec(fixture, slug);

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true, noEvidence: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.equal(result.evidenceBasis, 'operator-asserted');

  // retirement.json records the assertion
  const archiveDir = path.join(fixture.retiredDir, slug);
  const record = JSON.parse(fs.readFileSync(path.join(archiveDir, 'retirement.json'), 'utf8')) as { evidenceBasis: string; evidenceStatement?: string; consentFlags: { confirmRetire: boolean; noEvidence: boolean } };
  assert.equal(record.evidenceBasis, 'operator-asserted');
  assert.equal(record.evidenceStatement, 'evidence bar not met at retirement');
  assert.equal(record.consentFlags.noEvidence, true);
  assert.equal(record.consentFlags.confirmRetire, true);

  // Completion message names the operator assertion
  assert.equal(result.completionMessage, 'Retired checkout-confirmation (archive: .replaytest/retired/checkout-confirmation/). Retired on operator assertion (evidence bar not met). Keep the archive folder local to preserve the record. Restore recipe: retirement.json. Note: this tool cannot detect a write that lands at the exact moment of archiving, and if something else deletes files at the same time, the results can look like this tool\'s own partial work.');
  assert.match(result.completionMessage, /Retired on operator assertion/);
  assert.match(result.completionMessage, /evidence bar not met/);
});

// ---------------------------------------------------------------------------
// Second retire (timestamp-suffixed sibling)
// ---------------------------------------------------------------------------

test('retirePlan: second retire of a re-planned slug → timestamp-suffixed archive sibling', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';

  // First retire
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  let result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');

  // Re-plan the slug (fresh start after retirement)
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  // Second retire
  result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;

  // The first archive (slug) still exists, and the second archive is a sibling
  assert.equal(fs.existsSync(path.join(fixture.retiredDir, slug, 'retirement.json')), true);
  const entries = fs.readdirSync(fixture.retiredDir).filter((e) => e.startsWith(slug));
  assert.equal(entries.length, 2, `expected exactly 2 archive entries for ${slug}, got ${entries.length}`);
});

test('readRetiredRecord: a retired folder for a longer slug sharing a dash prefix is never counted as this slug\'s record', (t: TestContext) => {
  const fixture = mkFixture(t);
  // Only checkout-v2 is retired; checkout itself is not. A bare-prefix matcher
  // would wrongly claim checkout is retired here.
  fs.mkdirSync(path.join(fixture.retiredDir, 'checkout-v2'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, 'checkout-v2', 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', evidenceBasis: 'empty-search-trail', artifactManifest: [] }, null, 2)}\n`,
    'utf8',
  );
  assert.equal(isSlugRetired('checkout', fixture.retiredDir), false);
  assert.equal(readRetiredRecord('checkout', fixture.retiredDir), undefined);
  // The longer slug itself still resolves its own record.
  assert.notEqual(readRetiredRecord('checkout-v2', fixture.retiredDir), undefined);
});

test('retirePlan: archival moves only this slug\'s artifacts — a dash-prefix sibling journey keeps every file', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  // A live, un-retired sibling journey whose slug shares the dash prefix, with
  // artifacts in every glob-matched class. A slug-prefix matcher would sweep
  // all of these into checkout's archive.
  writeLive(fixture, 'checkout-v2', sidecar());
  writeSpec(fixture, 'checkout-v2');
  fs.writeFileSync(path.join(fixture.plansDir, 'checkout-v2.superseded-live.plan.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, 'checkout-v2.accepted-proposal.plan.json'), '{}\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');

  const survivors = fs.readdirSync(fixture.plansDir).filter((n) => n.startsWith('checkout-v2')).sort();
  assert.deepEqual(survivors, [
    'checkout-v2.accepted-proposal.plan.json',
    'checkout-v2.md',
    'checkout-v2.plan.json',
    'checkout-v2.superseded-live.plan.json',
  ]);
  assert.equal(fs.existsSync(path.join(fixture.generatedTestsDir, 'checkout-v2.spec.ts')), true);
  // And nothing of the sibling's landed in the archive.
  const archivedPlans = path.join(fixture.retiredDir, slug, 'plans');
  const archived = fs.existsSync(archivedPlans)
    ? fs.readdirSync(archivedPlans).filter((n) => n.startsWith('checkout-v2'))
    : [];
  assert.deepEqual(archived, []);
});

// ---------------------------------------------------------------------------
// retirement.json structure
// ---------------------------------------------------------------------------

test('retirePlan: retirement.json carries the reversal recipe and the trail', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  const trail = barMetTrail();
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: trail } }));
  writeSpec(fixture, slug);

  retirePlan(opts(fixture, slug, { confirmRetire: true }));

  const archiveDir = path.join(fixture.retiredDir, slug);
  const record = JSON.parse(fs.readFileSync(path.join(archiveDir, 'retirement.json'), 'utf8')) as {
    retiredAt: string;
    reversalRecipe: string[];
    trail: SidecarEmptySearch[];
    artifactManifest: Array<{ from: string; to: string }>;
  };
  assert.ok(record.reversalRecipe.length >= 4, 'reversal recipe must have at least 4 steps');
  assert.ok(record.reversalRecipe.some((step) => step.includes('Move the artifacts back')), 'recipe must name the move-back step');
  assert.ok(record.reversalRecipe.some((step) => step.includes('state-harvest')), 'recipe must name the harvested-state re-insertion step');
  // Both recipe arms mention state-harvest, so the arm choice needs its own
  // discriminator — the no-leftLive path must not render the in-record-list
  // variant.
  assert.ok(!record.reversalRecipe.some((step) => step.includes('leftLive')), 'the no-leftLive path must render the plain re-insertion step, not the in-record-list variant');
  assert.equal(record.reversalRecipe[2], `3. Run \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`, then \`replaytest heal\`, to re-establish heal state honestly.`);
  assert.equal(record.trail.length, 2);
  assert.ok(record.artifactManifest.length > 0, 'artifact manifest must be populated after moves');
});

test('retirePlan: retirement.json records left-live rows and makes recipe step 2 point to that record', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.writeFileSync(fixture.selectorAppliesPath, `${JSON.stringify([{ slug, canonicalSpecPath: 'tests/generated/other.spec.ts' }], null, 2)}\n`, 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  const record = JSON.parse(fs.readFileSync(path.join(fixture.retiredDir, slug, 'retirement.json'), 'utf8')) as {
    leftLive?: {
      rows: Array<{ rowKind: string; stateFile: string; slug: string; canonicalSpecPath?: string }>;
      stateFiles: string[];
    };
    reversalRecipe: string[];
  };
  assert.deepEqual(record.leftLive, {
    rows: [{ rowKind: 'selector-applies', stateFile: '.replaytest/state/selector-applies.json', slug, canonicalSpecPath: 'tests/generated/other.spec.ts' }],
    stateFiles: ['.replaytest/state/selector-applies.json'],
  });
  const restoreStep = record.reversalRecipe[1] ?? '';
  assert.equal(
    restoreStep,
    `2. Inspect retirement.json.leftLive.rows and retirement.json.leftLive.stateFiles before re-inserting the harvested state files from .replaytest/retired/${slug}/state-harvest/; these rows remain live and must not be duplicated. Restore only harvested entries that do not duplicate the in-record list.`,
  );
});

// ---------------------------------------------------------------------------
// gitignore: the 3-line re-include idiom keeps retired archives
// trackable while plans stay ignored (proven against a live git repo).
// ---------------------------------------------------------------------------

test('gitignore: the 3-line re-include idiom keeps retired archives trackable while runtime state stays ignored', (t: TestContext) => {
  const root = mkTempRoot(t);
  const gitInit = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(gitInit.status, 0, 'git init must succeed in the fixture repo');

  // Use the repo's OWN .gitignore (the 3-line re-include idiom).
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  fs.copyFileSync(path.join(repoRoot, '.gitignore'), path.join(root, '.gitignore'));

  // A retired archive path must be trackable (check-ignore exits 1 = NOT ignored).
  const archivePath = path.join('.replaytest', 'retired', 'zzz', 'retirement.json');
  fs.mkdirSync(path.join(root, '.replaytest', 'retired', 'zzz'), { recursive: true });
  fs.writeFileSync(path.join(root, archivePath), '{}\n', 'utf8');
  const checkIgnore = spawnSync('git', ['check-ignore', archivePath], { cwd: root, encoding: 'utf8' });
  assert.equal(checkIgnore.status, 1, `retired archive must NOT be ignored (check-ignore status ${checkIgnore.status})`);
  const addDryRun = spawnSync('git', ['add', '--dry-run', archivePath], { cwd: root, encoding: 'utf8' });
  assert.equal(addDryRun.status, 0);
  assert.match(addDryRun.stdout, /add '\.replaytest\/retired\/zzz\/retirement\.json'/, 'git add --dry-run must list the retired archive');

  // Runtime state must STILL be ignored (check-ignore exits 0 = ignored). The
  // probe path is one no published-tree policy re-includes — plan sidecars are
  // deliberately tracked in some trees, so they are not a policy-neutral probe.
  const statePath = path.join('.replaytest', 'state', 'heal-latest.json');
  fs.mkdirSync(path.join(root, '.replaytest', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, statePath), '{}\n', 'utf8');
  const stateCheck = spawnSync('git', ['check-ignore', statePath], { cwd: root, encoding: 'utf8' });
  assert.equal(stateCheck.status, 0, 'runtime state must remain ignored');
});

// ---------------------------------------------------------------------------
// Archival completeness: the archival moves the WHOLE recorded history — superseded-live,
// accepted-proposal, the superseded pair, the in-flight proposal, and frames.
// ---------------------------------------------------------------------------

test('retirePlan: the archival moves the whole recorded history into the archive (13 artifacts)', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  // In-flight proposal (the frustrated state before a retire).
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.plan.json`), '{}\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.md`), '# proposed\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.diff.md`), 'diff\n', 'utf8');
  // accept's superseded-live archive.
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.superseded-live.2026-08-01T00-00-00-000Z.json`), '{}\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.superseded-live.2026-08-01T00-00-00-000Z.md`), '# old\n', 'utf8');
  // accept's accepted-proposal archive.
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.accepted-proposal.2026-08-01T00-00-00-000Z.md`), '# prop\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.accepted-proposal.2026-08-01T00-00-00-000Z.diff.md`), 'diff\n', 'utf8');
  // reconcile's superseded pair.
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.superseded.plan.json`), '{}\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.superseded.md`), '# superseded\n', 'utf8');
  // Frames.
  fs.mkdirSync(path.join(fixture.framesDir, slug), { recursive: true });
  fs.writeFileSync(path.join(fixture.framesDir, slug, 'step-1.html'), '<html></html>\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;

  const archiveDir = path.join(fixture.retiredDir, slug);
  // Live artifacts moved.
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.md`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'tests', `${slug}.spec.ts`)), true);
  // Proposal moved.
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.proposed.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.proposed.md`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.proposed.diff.md`)), true);
  // Superseded-live moved.
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.superseded-live.2026-08-01T00-00-00-000Z.json`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.superseded-live.2026-08-01T00-00-00-000Z.md`)), true);
  // Accepted-proposal moved.
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.accepted-proposal.2026-08-01T00-00-00-000Z.md`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.accepted-proposal.2026-08-01T00-00-00-000Z.diff.md`)), true);
  // Superseded pair moved.
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.superseded.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(archiveDir, 'plans', `${slug}.superseded.md`)), true);
  // Frames moved.
  assert.equal(fs.existsSync(path.join(archiveDir, 'frames', slug, 'step-1.html')), true);

  // Live locations are empty.
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.proposed.plan.json`)), false);
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.superseded-live.2026-08-01T00-00-00-000Z.json`)), false);
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.accepted-proposal.2026-08-01T00-00-00-000Z.md`)), false);
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.superseded.plan.json`)), false);
  assert.equal(fs.existsSync(path.join(fixture.framesDir, slug)), false);

  // Enumeration guard: the frozen artifact roster plus the staged state-harvest row.
  assert.equal(result.movedArtifacts.length, 14, `expected 14 moved artifacts, got ${result.movedArtifacts.length}`);
});

// ---------------------------------------------------------------------------
// Count agreement: the three count-bearing surfaces agree on a mixed trail (one
// legacy-refetch entry that does not count).
// ---------------------------------------------------------------------------

test('qualifying count: evidence view, completion record, and door sentence agree on a mixed trail', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  const mixedTrail: SidecarEmptySearch[] = [
    emptySearch('2026-08-10T12:00:00.000Z'),
    emptySearch('2026-08-15T12:00:00.000Z'),
    emptySearch('2026-08-12T12:00:00.000Z', 720, { signatureSource: 'legacy-refetch' }),
  ];
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: mixedTrail } }));
  writeSpec(fixture, slug);

  // Surface 1: evidence view labels exactly 2 [qualifying] and names the legacy entry.
  const view = retirePlan(opts(fixture, slug));
  assert.equal(view.kind, 'evidence-view');
  if (view.kind !== 'evidence-view') return;
  assert.equal(view.status.qualifyingCount, 2);
  assert.equal(view.status.recordedCount, 3);
  const qualifyingLabels = view.message.match(/\[qualifying\]/g) ?? [];
  assert.equal(qualifyingLabels.length, 2, 'evidence view must label exactly 2 entries [qualifying]');
  assert.match(view.message, /\[different signature state — did not count\]/);

  // Surface 2: completion record counts the same 2.
  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.match(result.completionMessage, /Evidence: 2 empty searches over 720h between/);

  // Surface 3: the shared door sentence counts the same 2 and names the remainder.
  const sentence = trailMentionSentence(sidecar({ source: { ...sidecar().source, emptySearches: mixedTrail } }));
  assert.equal(
    sentence,
    'The evidence bar for retirement is met: 2 qualifying empty searches are recorded (3 recorded in total; 1 did not qualify).',
  );
});

// ---------------------------------------------------------------------------
// Provenance truth: a met trail is never recorded as operator-asserted,
// even when the superfluous --no-evidence flag was also passed.
// ---------------------------------------------------------------------------

test('retirePlan: bar met + superfluous --no-evidence → records empty-search-trail, never operator-asserted', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true, noEvidence: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.equal(result.evidenceBasis, 'empty-search-trail');

  const archiveDir = path.join(fixture.retiredDir, slug);
  const record = JSON.parse(fs.readFileSync(path.join(archiveDir, 'retirement.json'), 'utf8')) as {
    evidenceBasis: string;
    evidenceStatement?: string;
  };
  assert.equal(record.evidenceBasis, 'empty-search-trail');
  assert.equal(record.evidenceStatement, undefined, 'a met trail must never carry the operator-asserted statement');

  // Completion message: normal trail message, no operator-assertion wording.
  assert.doesNotMatch(result.completionMessage, /operator assertion/);
  assert.doesNotMatch(result.completionMessage, /evidence bar not met/);
  assert.match(result.completionMessage, /Evidence: 2 empty searches/);
  // The superfluous flag is disclosed, not silently dropped.
  assert.match(result.completionMessage, /--no-evidence flag was unnecessary/);
});

// ---------------------------------------------------------------------------
// Own-archive honesty: the reversal recipe names ITS OWN archive dir (possibly a
// timestamp-suffixed sibling), and door awareness names the MOST RECENT
// record with a prior-record count.
// ---------------------------------------------------------------------------

test('retirePlan: second-retire reversal recipe names its own suffixed archive dir', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';

  // First retire.
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  let result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');

  // Re-plan + second retire.
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;

  // The second archive is a timestamp-suffixed sibling.
  const entries = fs.readdirSync(fixture.retiredDir).filter((e) => e.startsWith(slug));
  assert.equal(entries.length, 2);
  const secondDir = entries.find((e) => e !== slug);
  assert.ok(secondDir !== undefined, 'a second-retire sibling dir must exist');

  // Its reversal recipe names ITS OWN archive dir, never the primary.
  const record = JSON.parse(fs.readFileSync(path.join(fixture.retiredDir, secondDir, 'retirement.json'), 'utf8')) as {
    reversalRecipe: string[];
  };
  const moveBack = record.reversalRecipe.find((step) => step.includes('Move the artifacts back'));
  assert.ok(moveBack !== undefined, 'recipe must name the move-back step');
  assert.ok(moveBack.includes(secondDir), `recipe must name its own archive dir ${secondDir}, got: ${moveBack}`);
  assert.ok(!moveBack.includes(`retired/${slug}/`), 'recipe must not name the primary archive dir');
});

test('door awareness: names the MOST RECENT record and counts prior siblings', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  // Two retired folders: primary (older) + suffixed sibling (newer).
  fs.mkdirSync(path.join(fixture.retiredDir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, slug, 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', evidenceBasis: 'empty-search-trail', artifactManifest: [] }, null, 2)}\n`,
    'utf8',
  );
  const secondDir = `${slug}-2026-08-18T12-00-00-000Z`;
  fs.mkdirSync(path.join(fixture.retiredDir, secondDir), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, secondDir, 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-18T12:00:00.000Z', evidenceBasis: 'operator-asserted', artifactManifest: [] }, null, 2)}\n`,
    'utf8',
  );

  const record = readRetiredRecord(slug, fixture.retiredDir);
  assert.ok(record !== undefined);
  assert.equal(record.retiredAt, '2026-08-18T12:00:00.000Z', 'must name the newest record');
  assert.equal(record.evidenceBasis, 'operator-asserted');
  assert.equal(record.priorRecordCount, 1);
  assert.equal(record.priorRecordPaths.length, 1);
  assert.ok(record.priorRecordPaths[0].includes(`${slug}/retirement.json`));

  const sentence = retiredDoorSentence(slug, record);
  assert.match(sentence, /1 prior retirement record exists/);
  assert.match(sentence, /evidence basis: operator-asserted/);
});

// ---------------------------------------------------------------------------
// Effect pins: the archival's side-effect mechanisms — frames move, heal
// prune + fingerprint recompute, proposal moves. Each turns RED when the
// mechanism is deleted from the production seam.
// ---------------------------------------------------------------------------

test('effect pin: frames directory moves into the archive (RED if the frames move is dropped)', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.mkdirSync(path.join(fixture.framesDir, slug), { recursive: true });
  fs.writeFileSync(path.join(fixture.framesDir, slug, 'step-1.html'), '<html></html>\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.equal(
    fs.existsSync(path.join(fixture.retiredDir, slug, 'frames', slug, 'step-1.html')),
    true,
    'frames must move into the archive',
  );
  assert.equal(fs.existsSync(path.join(fixture.framesDir, slug)), false, 'live frames dir must not remain in the workspace');
});

test('effect pin: heal-latest is pruned and suiteFingerprint recomputed (RED if prune or recompute is dropped)', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  // A heal-latest file with this slug's rows + a stale fingerprint.
  const healLatest = {
    observedSpecs: [
      { file: `tests/generated/${slug}.spec.ts`, status: 'ok' },
      { file: 'tests/generated/other.spec.ts', status: 'ok' },
    ],
    slugs: [{ slug, canonicalSpecPath: `tests/generated/${slug}.spec.ts` }, { slug: 'other' }],
    runScope: {
      files: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'],
      generatedSpecFiles: [`tests/generated/${slug}.spec.ts`],
      missingGeneratedSpecFiles: [],
    },
    suiteFingerprint: { stale: true },
  };
  fs.writeFileSync(fixture.healLatestPath, `${JSON.stringify(healLatest, null, 2)}\n`, 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;

  const raw = JSON.parse(fs.readFileSync(fixture.healLatestPath, 'utf8')) as {
    observedSpecs: Array<{ file: string }>;
    slugs: Array<{ slug: string }>;
    runScope: { files: string[]; generatedSpecFiles: string[]; missingGeneratedSpecFiles: string[] };
    suiteFingerprint: unknown;
  };
  assert.equal(raw.observedSpecs.some((o) => o.file.includes(`${slug}.spec.ts`)), false, 'slug rows must be pruned from observedSpecs');
  assert.equal(raw.slugs.some((s) => s.slug === slug), false, 'slug rows must be pruned from slugs');
  assert.equal(raw.runScope.files.some((f) => f.includes(`${slug}.spec.ts`)), false, 'slug must be pruned from runScope.files');
  assert.equal(raw.runScope.generatedSpecFiles.some((f) => f.includes(`${slug}.spec.ts`)), false, 'slug must be pruned from runScope.generatedSpecFiles');
  assert.equal(raw.runScope.missingGeneratedSpecFiles.some((f) => f.includes(`${slug}.spec.ts`)), false, 'slug must be pruned from runScope.missingGeneratedSpecFiles');
  assert.notDeepEqual(raw.suiteFingerprint, { stale: true }, 'stale fingerprint must be recomputed, not left in place');
  assert.ok(
    typeof raw.suiteFingerprint === 'object' && raw.suiteFingerprint !== null && 'digest' in raw.suiteFingerprint,
    'suiteFingerprint must be a recomputed fingerprint object',
  );
});

test('fingerprint freshness: a generated-spec change between outside collection and lease claim re-collects before publish', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  const other = path.join(fixture.generatedTestsDir, 'other.spec.ts');
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.writeFileSync(other, 'test("before", () => {});\n', 'utf8');
  fs.writeFileSync(fixture.healLatestPath, JSON.stringify({
    observedSpecs: [{ file: `tests/generated/${slug}.spec.ts` }, { file: 'tests/generated/other.spec.ts' }],
    slugs: [{ slug }, { slug: 'other' }],
    runScope: { files: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], generatedSpecFiles: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { stale: true },
  }), 'utf8');

  let outsideFingerprint: ReturnType<typeof collectGeneratedSuiteFingerprint> | undefined;
  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    beforeCleanupStateLease: (row) => {
      if (row.rowKind !== 'heal-latest') return;
      outsideFingerprint = collectGeneratedSuiteFingerprint(fixture.generatedTestsDir, fixture.root);
      fs.writeFileSync(other, 'test("after changed between collection and lease", () => {});\n', 'utf8');
    },
  });
  assert.equal(result.kind, 'retired');
  const published = (JSON.parse(fs.readFileSync(fixture.healLatestPath, 'utf8')) as {
    suiteFingerprint: ReturnType<typeof collectGeneratedSuiteFingerprint>;
  }).suiteFingerprint;
  const afterMutation = collectGeneratedSuiteFingerprint(fixture.generatedTestsDir, fixture.root);
  assert.notDeepEqual(published, outsideFingerprint, 'a stale outside fingerprint must never be published after the stat view changes');
  assert.deepEqual(published, afterMutation, 'the mismatch path must publish a fresh in-lease fingerprint of the mutated suite');
});

test('the pre-stat to fingerprint seam fires and publishes the fresh digest', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  const other = path.join(fixture.generatedTestsDir, 'other.spec.ts');
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.writeFileSync(other, 'test("before seam", () => {});\n', 'utf8');
  fs.writeFileSync(fixture.healLatestPath, JSON.stringify({
    observedSpecs: [{ file: `tests/generated/${slug}.spec.ts` }, { file: 'tests/generated/other.spec.ts' }],
    slugs: [{ slug }, { slug: 'other' }],
    runScope: { files: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], generatedSpecFiles: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { stale: true },
  }), 'utf8');

  let seamFired = false;
  let fingerprintBeforeSeam: ReturnType<typeof collectGeneratedSuiteFingerprint> | undefined;
  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    beforeCleanupFingerprint: (row) => {
      if (row.rowKind !== 'heal-latest') return;
      seamFired = true;
      fingerprintBeforeSeam = collectGeneratedSuiteFingerprint(fixture.generatedTestsDir, fixture.root);
      fs.writeFileSync(other, 'test("after seam", () => {});\n', 'utf8');
    },
  });
  assert.equal(result.kind, 'retired');
  assert.equal(seamFired, true, 'the production seam must fire between statViewPre and fingerprint');
  const published = (JSON.parse(fs.readFileSync(fixture.healLatestPath, 'utf8')) as {
    suiteFingerprint: ReturnType<typeof collectGeneratedSuiteFingerprint>;
  }).suiteFingerprint;
  const afterMutation = collectGeneratedSuiteFingerprint(fixture.generatedTestsDir, fixture.root);
  assert.notDeepEqual(published, fingerprintBeforeSeam, 'the seam mutation must not publish the pre-seam fingerprint');
  assert.deepEqual(published, afterMutation, 'the seam mutation must publish a fresh in-lease fingerprint');
});

test('production cleanup records statViewPre, seam, then fingerprint', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.writeFileSync(path.join(fixture.generatedTestsDir, 'other.spec.ts'), 'test("observer", () => {});\n', 'utf8');
  fs.writeFileSync(fixture.healLatestPath, JSON.stringify({
    observedSpecs: [{ file: `tests/generated/${slug}.spec.ts` }, { file: 'tests/generated/other.spec.ts' }],
    slugs: [{ slug }, { slug: 'other' }],
    runScope: { files: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], generatedSpecFiles: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { stale: true },
  }), 'utf8');

  const other = path.join(fixture.generatedTestsDir, 'other.spec.ts');
  const beforeMutation = collectGeneratedSuiteStatView(fixture.generatedTestsDir, fixture.root)
    .filter((entry) => entry.file.endsWith('/other.spec.ts'));
  const events: string[] = [];
  const observed: Array<{
    event: 'statViewPre' | 'seam' | 'fingerprint';
    collected: ReturnType<typeof collectGeneratedSuiteStatView> | ReturnType<typeof collectGeneratedSuiteFingerprint>;
  }> = [];
  const result = retirePlan({
    ...opts(fixture, slug, { confirmRetire: true }),
    beforeCleanupFingerprint: (row) => {
      if (row.rowKind === 'heal-latest') fs.writeFileSync(other, 'test("after observer seam", () => {});\n', 'utf8');
    },
    observeCleanupSuiteCollection: (event, row, collected) => {
      if (row.rowKind === 'heal-latest') {
        events.push(event);
        observed.push({ event, collected });
      }
    },
  });
  assert.equal(result.kind, 'retired');
  assert.deepEqual(events, ['statViewPre', 'seam', 'fingerprint'], 'the production path must preserve the ordered outside-collection contract');
  // Invariant this equality relies on: the retired spec is already deleted
  // when the pre-mutation control view is collected, so the full collection
  // and the observed view enumerate the same file set.
  assert.deepEqual(observed[0]?.collected, beforeMutation, 'the observed statViewPre must be the real pre-mutation collection');
  const observedFingerprint = observed.find((observation) => observation.event === 'fingerprint')?.collected;
  assert.deepEqual(
    observedFingerprint,
    collectGeneratedSuiteFingerprint(fixture.generatedTestsDir, fixture.root),
    'the observed fingerprint must be the real post-mutation collection',
  );
});

test('the historical fingerprint-then-stat block publishes a stale digest', async (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  const other = path.join(fixture.generatedTestsDir, 'other.spec.ts');
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.writeFileSync(other, 'test("before old order", () => {});\n', 'utf8');
  fs.writeFileSync(fixture.healLatestPath, JSON.stringify({
    observedSpecs: [{ file: `tests/generated/${slug}.spec.ts` }, { file: 'tests/generated/other.spec.ts' }],
    slugs: [{ slug }, { slug: 'other' }],
    runScope: { files: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], generatedSpecFiles: [`tests/generated/${slug}.spec.ts`, 'tests/generated/other.spec.ts'], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { stale: true },
  }), 'utf8');

  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), 'src'), 'replaytest-staged-old-order-');
  const stagedSourcePath = path.join(stagedSourceRoot, 'cli', 'verbs', 'retire.ts');
  const stagedCleanupPath = path.join(stagedSourceRoot, 'cli', 'verbs', 'retire-cleanup.ts');
  const stagedRetireOriginal = fs.readFileSync(stagedSourcePath, 'utf8');
  const stagedRetireDigest = createHash('sha256').update(stagedRetireOriginal).digest('hex');
  const original = fs.readFileSync(stagedCleanupPath, 'utf8');
  const originalDigest = createHash('sha256').update(original).digest('hex');
  const helperStart = original.indexOf('export function collectOutsideSuiteForCleanup');
  const helperEnd = original.indexOf('\n\nexport function absoluteWorkspacePath', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'the staged copy must contain the ordered outside-collection helper');
  const oldOrderHelper = `export function collectOutsideSuiteForCleanup(opts: RetireOptions, row: RetireCleanupRow): OutsideSuiteCollection | undefined {
  if (row.rowKind !== 'heal-latest') return undefined;
  const fingerprint = collectGeneratedSuiteFingerprint(opts.generatedTestsDir, opts.workspaceRoot);
  opts.observeCleanupSuiteCollection?.('fingerprint', row, fingerprint);
  if (opts.beforeCleanupFingerprint !== undefined) {
    opts.observeCleanupSuiteCollection?.('seam', row, fingerprint);
    opts.beforeCleanupFingerprint(row);
  }
  const statViewPre = collectGeneratedSuiteStatView(opts.generatedTestsDir, opts.workspaceRoot);
  opts.observeCleanupSuiteCollection?.('statViewPre', row, statViewPre);
  return { fingerprint, statViewPre };
  }`;
  fs.writeFileSync(stagedCleanupPath, `${original.slice(0, helperStart)}${oldOrderHelper}${original.slice(helperEnd)}`, 'utf8');
  const importStagedRetire = async (tag: string): Promise<{ retirePlan: typeof retirePlan }> => {
    const importPath = `} from './retire-cleanup.js?${tag}';`;
    const rewritten = stagedRetireOriginal.replace("} from './retire-cleanup.js';", importPath);
    assert.notEqual(rewritten, stagedRetireOriginal, 'the staged retire source must contain the expected cleanup import anchor before cache-busting');
    fs.writeFileSync(stagedSourcePath, rewritten, 'utf8');
    return await import(`${pathToFileURL(stagedSourcePath).href}?${tag}=${Date.now()}`) as { retirePlan: typeof retirePlan };
  };
  try {
    const stagedRetire = await importStagedRetire('staged-old-order');
    const result = stagedRetire.retirePlan({
      ...opts(fixture, slug, { confirmRetire: true }),
      beforeCleanupFingerprint: (row) => {
        if (row.rowKind === 'heal-latest') fs.writeFileSync(other, 'test("after old-order seam", () => {});\n', 'utf8');
      },
    });
    assert.equal(result.kind, 'retired');
    const published = (JSON.parse(fs.readFileSync(fixture.healLatestPath, 'utf8')) as {
      suiteFingerprint: ReturnType<typeof collectGeneratedSuiteFingerprint>;
    }).suiteFingerprint;
    const truth = collectGeneratedSuiteFingerprint(fixture.generatedTestsDir, fixture.root);
    assert.notDeepEqual(published, truth, 'the staged old-order block must demonstrate the stale publication defect');

    const evasionFixture = mkFixture(t);
    const evasionSlug = 'checkout-confirmation';
    const evasionOther = path.join(evasionFixture.generatedTestsDir, 'other.spec.ts');
    writeLive(evasionFixture, evasionSlug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
    writeSpec(evasionFixture, evasionSlug);
    fs.writeFileSync(evasionOther, 'test("before evasion seam", () => {});\n', 'utf8');
    fs.writeFileSync(evasionFixture.healLatestPath, JSON.stringify({
      observedSpecs: [{ file: `tests/generated/${evasionSlug}.spec.ts` }, { file: 'tests/generated/other.spec.ts' }],
      slugs: [{ slug: evasionSlug }, { slug: 'other' }],
      runScope: { files: [`tests/generated/${evasionSlug}.spec.ts`, 'tests/generated/other.spec.ts'], generatedSpecFiles: [`tests/generated/${evasionSlug}.spec.ts`, 'tests/generated/other.spec.ts'], missingGeneratedSpecFiles: [] },
      suiteFingerprint: { stale: true },
    }), 'utf8');
    const evasionHelper = `export function collectOutsideSuiteForCleanup(opts: RetireOptions, row: RetireCleanupRow): OutsideSuiteCollection | undefined {
  if (row.rowKind !== 'heal-latest') return undefined;
  const fingerprint = collectGeneratedSuiteFingerprint(opts.generatedTestsDir, opts.workspaceRoot);
  const statViewPre = collectGeneratedSuiteStatView(opts.generatedTestsDir, opts.workspaceRoot);
  opts.observeCleanupSuiteCollection?.('statViewPre', row, statViewPre);
  opts.observeCleanupSuiteCollection?.('seam', row, statViewPre);
  opts.beforeCleanupFingerprint?.(row);
  opts.observeCleanupSuiteCollection?.('fingerprint', row, fingerprint);
  return { fingerprint, statViewPre };
}`;
    fs.writeFileSync(stagedCleanupPath, `${original.slice(0, helperStart)}${evasionHelper}${original.slice(helperEnd)}`, 'utf8');
    const evasionRetire = await importStagedRetire('staged-evasion');
    const evasionBeforeMutation = collectGeneratedSuiteStatView(evasionFixture.generatedTestsDir, evasionFixture.root)
      .filter((entry) => entry.file.endsWith('/other.spec.ts'));
    const evasionObservations: Array<{
      event: 'statViewPre' | 'seam' | 'fingerprint';
      collected: ReturnType<typeof collectGeneratedSuiteStatView> | ReturnType<typeof collectGeneratedSuiteFingerprint>;
    }> = [];
    assert.throws(() => {
      const evasionResult = evasionRetire.retirePlan({
        ...opts(evasionFixture, evasionSlug, { confirmRetire: true }),
        beforeCleanupFingerprint: (row) => {
          if (row.rowKind === 'heal-latest') fs.writeFileSync(evasionOther, 'test("after evasion seam", () => {});\n', 'utf8');
        },
        observeCleanupSuiteCollection: (event, row, collected) => {
          if (row.rowKind === 'heal-latest') evasionObservations.push({ event, collected });
        },
      });
      assert.equal(evasionResult.kind, 'retired');
      assert.deepEqual(evasionObservations.map(({ event }) => event), ['statViewPre', 'seam', 'fingerprint']);
      assert.deepEqual(evasionObservations[0]?.collected, evasionBeforeMutation, 'the evasion stat observation must remain pre-mutation');
      assert.deepEqual(
        evasionObservations.find((observation) => observation.event === 'fingerprint')?.collected,
        collectGeneratedSuiteFingerprint(evasionFixture.generatedTestsDir, evasionFixture.root),
        'the evasion fingerprint observation must be post-mutation',
      );
    }, /the evasion fingerprint observation must be post-mutation/);
  } finally {
    // Restore, capture, clean, THEN assert — a RED here must not leak the
    // staging dir or mask the plant's failure message.
    fs.writeFileSync(stagedCleanupPath, original, 'utf8');
    fs.writeFileSync(stagedSourcePath, stagedRetireOriginal, 'utf8');
    const finalDigest = createHash('sha256').update(fs.readFileSync(stagedCleanupPath)).digest('hex');
    const finalRetireDigest = createHash('sha256').update(fs.readFileSync(stagedSourcePath)).digest('hex');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    assert.equal(finalDigest, originalDigest, 'the staged old-order plant must restore byte-identically');
    assert.equal(finalRetireDigest, stagedRetireDigest, 'the staged retire import cache-buster must restore byte-identically');
  }
});

test('effect pin: in-flight proposal artifacts move into the archive (RED if proposal moves are dropped)', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.plan.json`), '{}\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.md`), '# proposed\n', 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.diff.md`), 'diff\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  assert.equal(fs.existsSync(path.join(fixture.retiredDir, slug, 'plans', `${slug}.proposed.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(fixture.retiredDir, slug, 'plans', `${slug}.proposed.md`)), true);
  assert.equal(fs.existsSync(path.join(fixture.retiredDir, slug, 'plans', `${slug}.proposed.diff.md`)), true);
  assert.equal(fs.existsSync(path.join(fixture.plansDir, `${slug}.proposed.plan.json`)), false);
});

// ---------------------------------------------------------------------------
// Beyond-table sweep: an app-scoped triage report cache carries an
// `.app-<hash>` suffix, so it must be harvested and cleaned up too — matching
// only the unsuffixed name leaves an app-scoped workspace's cache behind.
// ---------------------------------------------------------------------------

test('retirePlan: app-scoped triage report caches are harvested and cleaned up, sibling slugs untouched', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  fs.mkdirSync(fixture.triageEvidenceDir, { recursive: true });
  const scopedCache = path.join(fixture.triageEvidenceDir, `${slug}.app-0123456789abcdef.report-cache.json`);
  fs.writeFileSync(scopedCache, `${JSON.stringify({ kind: 'triage-report-cache', version: 3 }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(fixture.triageEvidenceDir, `${slug}.json`), '{"verdict":"no-candidates"}\n', 'utf8');
  // A sibling slug that merely shares the prefix must be left alone.
  const sibling = `${slug}-v2`;
  const siblingCache = path.join(fixture.triageEvidenceDir, `${sibling}.app-0123456789abcdef.report-cache.json`);
  fs.writeFileSync(siblingCache, '{"kind":"triage-report-cache"}\n', 'utf8');

  const result = retirePlan(opts(fixture, slug, { confirmRetire: true }));
  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;

  assert.equal(fs.existsSync(scopedCache), false, 'the app-scoped cache must be cleaned up');
  assert.equal(fs.existsSync(siblingCache), true, 'a sibling slug sharing the prefix must be untouched');

  const record = JSON.parse(fs.readFileSync(path.join(fixture.retiredDir, slug, 'retirement.json'), 'utf8')) as {
    harvestedState: { files?: Array<{ path: string; digest: string }> };
  };
  const appHarvest = record.harvestedState.files?.find((entry) => entry.path.endsWith(`${slug}.app-0123456789abcdef.report-cache.json`));
  assert.ok(appHarvest !== undefined, 'the app-scoped cache must be harvested as a staged file reference');
  assert.equal(typeof appHarvest?.digest, 'string');
  assert.equal(fs.existsSync(path.join(fixture.retiredDir, slug, 'state-harvest', `${slug}.app-0123456789abcdef.report-cache.json`)), true);
});

// ---------------------------------------------------------------------------
// Partial-failure honesty: the report is factually right — it never asks the
// operator to redo cleanup the code already completed, it names the state they
// are actually left in, and every path it prints is workspace-relative.
// ---------------------------------------------------------------------------

test('partial failure: the report credits completed cleanup and names the drift trap', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  writeHashBaseline(fixture, slug);

  // The spec's move fails (a real EACCES shape); every other move succeeds.
  const result = retirePlan(opts(fixture, slug, {
    confirmRetire: true,
    moveFile: (source, destination) => {
      if (source.endsWith(`${slug}.spec.ts`)) throw new Error(`EACCES: permission denied, rename '${source}'`);
      fs.renameSync(source, destination);
    },
  }));

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'partial-failure');

  // The cleanup steps that COMPLETED are credited, not re-requested.
  assert.match(result.message, /State cleanup:/);
  assert.match(result.message, /✓ spec-emitted-hashes/);
  assert.match(result.message, /✓ selector-applies/);
  assert.match(result.message, /✓ triage-latest/);
  assert.match(result.message, /✓ heal-latest/);
  assert.doesNotMatch(
    result.message,
    /Remove the harvested state entries/,
    'the report must never ask the operator to redo cleanup the code already completed',
  );

  // The state the operator is actually left in is named, with the trap remedy.
  assert.match(result.message, /The spec is still live in tests\/generated\/checkout-confirmation\.spec\.ts/);
  assert.match(result.message, /preflight will report plan\/spec drift as unknown/);
  assert.match(result.message, /Do NOT run `replaytest scaffold checkout-confirmation --force`/);
  assert.match(result.message, /harvestedState\.hashEntry/);

  // The hash entry really was removed — the report's claim is checkable on disk.
  const hashes = JSON.parse(fs.readFileSync(fixture.specEmittedHashesPath, 'utf8')) as { entries: Array<{ slug: string }> };
  assert.equal(hashes.entries.some((e) => e.slug === slug), false);

  // No raw absolute machine path leaks into the report.
  assert.doesNotMatch(result.message, new RegExp(escapeForRegExp(fixture.root)), 'paths must be workspace-relative');
});

test('partial failure: the drift-trap warning stays silent when no hash baseline was ever removed', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);
  // No spec-emitted-hashes baseline at all: nothing to remove.

  const result = retirePlan(opts(fixture, slug, {
    confirmRetire: true,
    moveFile: (source, destination) => {
      if (source.endsWith(`${slug}.spec.ts`)) throw new Error(`EACCES: permission denied, rename '${source}'`);
      fs.renameSync(source, destination);
    },
  }));

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.match(result.message, /✓ spec-emitted-hashes/, 'the step still completed');
  assert.doesNotMatch(
    result.message,
    /its emitted-hash baseline was removed/,
    'the report must not claim a baseline was removed when none existed',
  );
});

// ---------------------------------------------------------------------------
// Disclosure: a failed manifest re-write is disclosed, never swallowed — the
// archived record must not silently claim it holds no artifacts.
// ---------------------------------------------------------------------------

test('retirePlan: final retirement record is atomically published after the frozen roster completes', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  writeLive(fixture, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
  writeSpec(fixture, slug);

  // Make retirement.json unwritable once the record has been written, so only
  // the post-move manifest re-write fails.
  const recordPath = path.join(fixture.retiredDir, slug, 'retirement.json');
  const result = retirePlan(opts(fixture, slug, {
    confirmRetire: true,
    moveFile: (source, destination) => {
      fs.renameSync(source, destination);
      if (fs.existsSync(recordPath)) fs.chmodSync(recordPath, 0o444);
    },
  }));
  fs.chmodSync(recordPath, 0o644);

  assert.equal(result.kind, 'retired');
  if (result.kind !== 'retired') return;
  const finalRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { status?: string; artifactManifest?: unknown[] };
  assert.equal(finalRecord.status, 'completed');
  assert.ok((finalRecord.artifactManifest?.length ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// Door awareness: byte-identical guarantee
// ---------------------------------------------------------------------------

test('appendRetiredAwareness: un-retired slug returns the message byte-identical', (t: TestContext) => {
  const fixture = mkFixture(t);
  const original = 'No plan found for "some-slug" — run: replaytest plan <distinctId>.';
  const result = appendRetiredAwareness('some-slug', original, fixture.retiredDir);
  assert.equal(result, original, 'un-retired slug must keep refusal text byte-identical');
});

test('appendRetiredAwareness: retired slug appends a suffix naming the record', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  fs.mkdirSync(path.join(fixture.retiredDir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, slug, 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', consentFlags: { confirmRetire: true, noEvidence: false }, evidenceBasis: 'empty-search-trail', trail: [], successorObservations: [], harvestedState: {}, artifactManifest: [], reversalRecipe: [] }, null, 2)}\n`,
    'utf8',
  );
  const original = 'No plan found for "checkout-confirmation" — run: replaytest plan <distinctId>.';
  const result = appendRetiredAwareness(slug, original, fixture.retiredDir);
  assert.notEqual(result, original, 'retired slug must get a suffix');
  assert.match(result, /retired on/i);
  assert.match(result, /retirement\.json/);
});

test('isSlugRetired: false when no folder, true when folder exists', (t: TestContext) => {
  const fixture = mkFixture(t);
  assert.equal(isSlugRetired('nope', fixture.retiredDir), false);
  fs.mkdirSync(path.join(fixture.retiredDir, 'yep'), { recursive: true });
  assert.equal(isSlugRetired('yep', fixture.retiredDir), true);
});

// ---------------------------------------------------------------------------
// readRetiredRecord
// ---------------------------------------------------------------------------

test('readRetiredRecord: returns undefined when not retired, the record when retired', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  assert.equal(readRetiredRecord(slug, fixture.retiredDir), undefined);
  fs.mkdirSync(path.join(fixture.retiredDir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, slug, 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', consentFlags: { confirmRetire: true, noEvidence: false }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: {}, artifactManifest: [], reversalRecipe: [] }, null, 2)}\n`,
    'utf8',
  );
  const record = readRetiredRecord(slug, fixture.retiredDir);
  assert.ok(record !== undefined);
  assert.equal(record?.evidenceBasis, 'operator-asserted');
});

// ---------------------------------------------------------------------------
// Handler-level: runRetire with no slug emits a usage error
// ---------------------------------------------------------------------------

test('runRetire: no slug → usage error outcome', () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runRetire([], { log: (line) => output.push(line) });
    assert.ok(output.some((line) => line.includes('replaytest retire')));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runRetire: unknown flag → refusal with usage', (t: TestContext) => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const fixture = mkFixture(t);
    const output: string[] = [];
    runRetire(['slug', '--bogus'], { log: (line) => output.push(line), retiredDir: fixture.retiredDir });
    assert.ok(output.some((line) => line.includes('Unknown flag: --bogus')));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runRetire: --recover-crashed-locks cannot be combined with granular steal flags', (t: TestContext) => {
  const fixture = mkFixture(t);
  const control = mkFixture(t);
  const slug = 'checkout-confirmation';
  for (const target of [fixture, control]) {
    writeLive(target, slug, sidecar({ source: { ...sidecar().source, emptySearches: barMetTrail() } }));
    writeRetireLock(target, 99_999_999);
    writeStateLock(target, process.pid);
  }
  const retireLockPath = path.join(fixture.retiredDir, '.retire-lock');
  const stateLockPath = path.join(path.dirname(fixture.healLatestPath), '.state-lock');
  const retireBefore = fs.readFileSync(retireLockPath, 'utf8');
  const stateBefore = fs.readFileSync(stateLockPath, 'utf8');
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runRetire([slug, '--confirm-retire', '--steal-lock', '--steal-state-lock', '--recover-crashed-locks'], {
      ...fixture,
      workspaceRoot: fixture.root,
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(output[0]?.split('\n')[0], 'Use either --recover-crashed-locks or the explicit flags, not both.');
    assert.match(output[0] ?? '', /Usage: replaytest retire/);
    assert.equal(fs.readFileSync(retireLockPath, 'utf8'), retireBefore, 'usage refusal must preserve the retire lock bytes');
    assert.equal(fs.readFileSync(stateLockPath, 'utf8'), stateBefore, 'usage refusal must preserve the state lock bytes');

    const controlResult = retirePlan(opts(control, slug, { confirmRetire: true, stealLock: true, stealStateLock: true }));
    assert.equal(controlResult.kind, 'retired', 'the granular triple remains a working explicit override');
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('production JSON: runRetire keeps lock progress on stderr and one parseable refusal on stdout', async (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'json-held';
  writeLive(fixture, slug, sidecar());
  const stateDir = path.join(fixture.root, '.replaytest', 'state');
  const holder = startStateLockHolder(stateDir, CHILD_BOOT_BUDGET_MS);
  const priorWait = process.env[STATE_LOCK_WAIT_ENV];
  const priorExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    waitForStateLock(stateDir, holder.readyPath);
    // 4,000 ms: the progress line's emit window is ~100 ms wide against a
    // 25–99 ms jitter loop, so 2,100 ms missed under load ~12.5% of runs
    // (measured 40-trial burn); ~2 s of slack makes the
    // assertion load-proof without relaxing it.
    process.env[STATE_LOCK_WAIT_ENV] = '4000';
    process.exitCode = undefined;
    runRetire([slug, '--confirm-retire', '--no-evidence', '--json'], {
      ...fixture,
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1, 'the CLI stdout capture contains the one JSON document only');
    assert.equal((JSON.parse(stdout[0] ?? '{}') as { error?: { code?: string } }).error?.code, 'state-lock-held');
    assert.ok(stderr.some((line) => line.includes('waiting for shared state-writer lock')));
  } finally {
    process.exitCode = priorExitCode;
    if (priorWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = priorWait;
    const holderExit = waitForHolder(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
});

// ---------------------------------------------------------------------------
// accept: retired-no-resurrect guard regression
// ---------------------------------------------------------------------------

test('acceptProposal: retired slug with proposal but no live plan → retired-no-resurrect refusal', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  // A proposal exists (the frustrated state before a retire), no live plan,
  // and a retired folder — the silent-resurrect scenario.
  const proposed = sidecar();
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.plan.json`), `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.join(fixture.retiredDir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.retiredDir, slug, 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', consentFlags: { confirmRetire: true, noEvidence: false }, evidenceBasis: 'empty-search-trail', trail: [], successorObservations: [], harvestedState: {}, artifactManifest: [], reversalRecipe: [] }, null, 2)}\n`,
    'utf8',
  );

  const result = acceptProposal({
    slug,
    plansDir: fixture.plansDir,
    force: false,
    confirmDifferentJourney: false,
    workspaceRoot: fixture.root,
    retiredDir: fixture.retiredDir,
    now: () => NOW,
  });

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  assert.equal(result.code, 'retired-no-resurrect');
  assert.match(result.message, /retired on/i);
  assert.match(result.message, /retirement\.json/);
  assert.match(result.message, /re-plan/i);
});

/**
 * Shared sentence: `accept`'s door builds its record sentence from the SHARED helper,
 * not a private copy. Proven on a second-retire fixture, where the two wordings
 * differ: the shared sentence names the newest record and counts the prior one.
 */
test('acceptProposal: the retired-no-resurrect refusal uses the shared door sentence, not a private copy', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'checkout-confirmation';
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.proposed.plan.json`), `${JSON.stringify(sidecar(), null, 2)}\n`, 'utf8');

  const writeRecord = (dir: string, retiredAt: string, basis: string): void => {
    fs.mkdirSync(path.join(fixture.retiredDir, dir), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.retiredDir, dir, 'retirement.json'),
      `${JSON.stringify({ status: 'completed', retiredAt, evidenceBasis: basis, artifactManifest: [] }, null, 2)}\n`,
      'utf8',
    );
  };
  writeRecord(slug, '2026-08-01T00:00:00.000Z', 'operator-asserted');
  const newest = `${slug}-2026-08-18T12-00-00-000Z`;
  writeRecord(newest, '2026-08-18T12:00:00.000Z', 'empty-search-trail');

  const result = acceptProposal({
    slug,
    plansDir: fixture.plansDir,
    force: false,
    confirmDifferentJourney: false,
    workspaceRoot: fixture.root,
    retiredDir: fixture.retiredDir,
    now: () => NOW,
  });

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') return;
  const record = readRetiredRecord(slug, fixture.retiredDir);
  assert.ok(record !== undefined);
  assert.ok(
    result.message.includes(retiredDoorSentence(slug, record)),
    'accept must embed the shared door sentence verbatim',
  );
  assert.match(result.message, /retired on 2026-08-18T12:00:00\.000Z/, 'must name the NEWEST retirement');
  assert.match(result.message, /1 prior retirement record exists/);
});
