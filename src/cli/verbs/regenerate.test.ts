import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { buildVerbHelpText, runRegenerate } from '../../cli.js';
import { segmentJourneys } from '../../journeys.js';
import type { NeutralSession } from '../../neutral-session.js';
import type { CapMetadata, CoarseSession } from '../../providers/posthog-adapter.js';
import { buildSidecar, SIGNATURE_SEMANTICS_VERSION, type Sidecar } from '../../sidecar.js';
import { PLAN_HASH_DOMAIN, SPEC_EMITTED_HASHES_SCHEMA, specEmittedHashesPath } from '../../spec-emitted-hashes.js';
import { orderConfirmationSteps, neutralSessionFromSteps } from './test-support.js';

function workspace(t: TestContext): { root: string; plansDir: string; generatedTestsDir: string } {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-regenerate-cli-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  return { root, plansDir, generatedTestsDir: path.join(root, 'tests', 'generated') };
}

function sidecarFor(session: NeutralSession): Sidecar {
  const journey = segmentJourneys(session)[0]!;
  return buildSidecar(journey, {
    distinctId: session.distinctId,
    sessionId: session.id,
    journeyIndex: 0,
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    wizardStepParamNames: [],
  });
}

function coarse(session: NeutralSession): CoarseSession {
  return {
    sessionId: session.id,
    distinctId: session.distinctId,
    firstTs: session.startedAt,
    lastTs: session.endedAt,
    navPath: session.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: session.steps.filter((step) => step.kind === 'submit').length,
    eventCount: session.steps.length,
  };
}

function validEmittedHashRecord(): string {
  return `${JSON.stringify({
    schema: SPEC_EMITTED_HASHES_SCHEMA,
    algorithm: 'sha256',
    entries: [{
      slug: 'existing-baseline',
      specPath: 'tests/generated/existing-baseline.spec.ts',
      specSha256: 'a'.repeat(64),
      generatedAt: '2026-08-12T00:00:00.000Z',
      planSha256: 'b'.repeat(64),
      planHashDomain: PLAN_HASH_DOMAIN,
    }],
  }, null, 2)}\n`;
}

test('runRegenerate: writes the existing proposal slot and JSON reports its tier, proposal paths, and never-merge spec pointer', async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const fresh = neutralSessionFromSteps('fresh-session', 'fresh-user', orderConfirmationSteps('1002'));
  fs.writeFileSync(path.join(target.plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const recordPath = specEmittedHashesPath(target.root);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, validEmittedHashRecord(), 'utf8');
  const recordBytesBefore = fs.readFileSync(recordPath);
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 1, totalSessionsAtScanStart: 1,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const lines: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRegenerate([slug, '--json'], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [coarse(fresh)], meta }),
      fetchNeutralSessionsLight: () => [fresh],
      fetchNeutralSessionsWithDomEnrichment: async () => [fresh],
      progress: () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = priorExitCode;
  }
  assert.equal(fs.existsSync(path.join(target.plansDir, `${slug}.proposed.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(target.plansDir, `${slug}.proposed.md`)), true);
  assert.equal(fs.existsSync(path.join(target.plansDir, `${slug}.proposed.diff.md`)), true);
  // The REAL `regenerate` write
  // path emits the rebuilt rendering AND the regeneration marker. The marker
  // only survives when the diff is computed after `source.regeneration` is
  // stamped — this pin is on the production channel for exactly that reason.
  const regenDiffFile = fs.readFileSync(path.join(target.plansDir, `${slug}.proposed.diff.md`), 'utf8');
  assert.match(regenDiffFile, /^# Plan diff\n\nChanged: /);
  assert.match(regenDiffFile, /^- Source: session old-session → fresh-session.*— regenerated from fresh traffic$/m);
  assert.equal(regenDiffFile.includes('["'), false, 'the persisted regenerate diff must carry no JSON array blob');
  assert.deepEqual(fs.readFileSync(recordPath), recordBytesBefore, 'regenerate writes only the proposal triple, never the emitted-spec hash record');
  const json = JSON.parse(lines[0] ?? '') as { regenerated: { tier: string; proposal: { diffPath: string }; specDiffPointer: string } };
  assert.equal(json.regenerated.tier, 'same-signature');
  assert.match(json.regenerated.proposal.diffPath, /\.proposed\.diff\.md$/);
  assert.match(json.regenerated.specDiffPointer, /never merges/);
});

test('runRegenerate: the proposal writer preserves the leading fidelity summary and per-step lost-field line', async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const fresh = neutralSessionFromSteps('fresh-session', 'fresh-user', orderConfirmationSteps('1002'));
  old.steps.splice(3, 0, {
    kind: 'input',
    url: 'http://localhost:8000/orders/1001/pay',
    at: '2026-07-09T00:00:02.500Z',
    target: { tag: 'input', id: 'email', labelText: 'Email', attributes: { type: 'email' } },
  });
  fresh.steps.splice(3, 0, {
    kind: 'input',
    url: 'http://localhost:8000/orders/1002/pay',
    at: '2026-07-09T00:00:02.500Z',
    target: { tag: 'input', id: 'email', labelText: 'Email' },
  });
  fs.writeFileSync(path.join(target.plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 1, totalSessionsAtScanStart: 1,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const priorExitCode = process.exitCode;
  const lines: string[] = [];
  try {
    process.exitCode = undefined;
    await runRegenerate([slug], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [coarse(fresh)], meta }),
      fetchNeutralSessionsLight: () => [fresh],
      fetchNeutralSessionsWithDomEnrichment: async () => [fresh],
      progress: () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = priorExitCode;
  }

  const proposedJson = JSON.parse(fs.readFileSync(path.join(target.plansDir, `${slug}.proposed.plan.json`), 'utf8')) as Sidecar;
  assert.deepEqual(proposedJson.steps.find((step) => step.label === 'Email')?.warnings, ['fidelity-regression']);
  const proposedMarkdown = fs.readFileSync(path.join(target.plansDir, `${slug}.proposed.md`), 'utf8');
  const expectedSummary = '1 step regresses vs the retained plan — review before accept';
  assert.equal(proposedMarkdown.split('\n')[0], expectedSummary);
  assert.match(proposedMarkdown, /input type changed email → \(none\)/);
  assert.equal(lines.join('\n').split('\n').filter((line) => line === expectedSummary).length, 1);
});

test('runRegenerate: refuses an unresolved proposal rather than force-overwriting the shared review slot', async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  fs.writeFileSync(path.join(target.plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(target.plansDir, `${slug}.proposed.plan.json`), '{}\n', 'utf8');
  const lines: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRegenerate([slug, '--json'], {
      plansDir: target.plansDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      log: (line) => lines.push(line),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = priorExitCode;
  }
  const refusal = JSON.parse(lines[0] ?? '') as { error: { code: string; message: string; search?: unknown } };
  assert.equal(refusal.error.code, 'proposal-slot-occupied');
  assert.equal(refusal.error.search, undefined, 'a proposal-slot collision must not fabricate an empty traffic search');
  assert.match(refusal.error.message, /unresolved proposal/);
  assert.match(refusal.error.message, /replaytest accept order-confirmation/);
});

test('runRegenerate: --help is side-effect-free before any slug/config read', async () => {
  const lines: string[] = [];
  await runRegenerate(['--help'], { log: (line) => lines.push(line) });
  assert.deepEqual(lines, [buildVerbHelpText('regenerate')]);
});

test('runRegenerate: the app-scope disclosure LEADS the REFUSAL too, not just the success rendering', async (t: TestContext) => {
  // The refusal path renders through its own call site. A reader who scoped a
  // run needs the boundary before the refusal for the same reason they need it
  // before a table: "no fresh traffic" means something different inside a
  // declared property than across all of them.
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const foreign = neutralSessionFromSteps('foreign-session', 'foreign-user', orderConfirmationSteps('1003').map(
    (step) => ({ ...step, url: step.url.replace('http://localhost:8000', 'http://other.test') }),
  ));
  fs.writeFileSync(path.join(target.plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 1, totalSessionsAtScanStart: 1,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };

  const lines: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRegenerate([slug, '--app', 'shop'], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: { shop: ['http://localhost:8000'] } }),
      fetchCoarseSessions: () => ({ sessions: [coarse(foreign)], meta }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = priorExitCode;
  }

  const rendered = (lines[0] ?? '').split('\n');
  assert.equal(rendered[0], 'ⓘ Scoped to shop: localhost:8000.');
  assert.equal(rendered[1], 'ⓘ 1 session belonged to other apps and was excluded by your scope.');
  assert.match(rendered[2], /^No plannable fresh candidate was found\./, 'the refusal follows the boundary, never precedes it');
  assert.match(rendered[2], /in app scope shop/);
});

test('runRegenerate: the app-scope disclosure LEADS the human result, above the rebuilt-plan body', async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const fresh = neutralSessionFromSteps('fresh-session', 'fresh-user', orderConfirmationSteps('1002'));
  const foreign = neutralSessionFromSteps('foreign-session', 'foreign-user', orderConfirmationSteps('1003').map(
    (step) => ({ ...step, url: step.url.replace('http://localhost:8000', 'http://other.test') }),
  ));
  fs.writeFileSync(path.join(target.plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 2, totalSessionsAtScanStart: 2,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };

  const lines: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRegenerate([slug, '--app', 'shop'], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: { shop: ['http://localhost:8000'] } }),
      fetchCoarseSessions: () => ({ sessions: [coarse(fresh), coarse(foreign)], meta }),
      fetchNeutralSessionsLight: () => [fresh],
      fetchNeutralSessionsWithDomEnrichment: async () => [fresh],
      progress: () => {},
      log: (line) => lines.push(line),
    });
  } finally {
    process.exitCode = priorExitCode;
  }

  const rendered = (lines[0] ?? '').split('\n');
  assert.equal(rendered[0], 'ⓘ Scoped to shop: localhost:8000.');
  assert.equal(rendered[1], 'ⓘ 1 session belonged to other apps and was excluded by your scope.');
  assert.ok(!rendered[2].startsWith('ⓘ Scoped to'), 'the regenerate body follows the boundary, never precedes it');
  assert.doesNotMatch(lines.join('\n'), /fidelity|regress/i);
});

test('runRegenerate: a genuine empty search persists the recorded trail to the LIVE sidecar; a scan failure leaves it byte-untouched', async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const sidecarPath = path.join(target.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    // Genuine empty scan: the refusal records an empty-search entry AND the
    // live sidecar on disk carries it after the run — durability is the point
    // of the trail (the next run, possibly days later, must see this one).
    await runRegenerate([slug], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [], meta }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: () => {},
      log: () => {},
    });
  } finally {
    process.exitCode = priorExitCode;
  }
  const persisted = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
  assert.equal(persisted.source.emptySearches?.length, 1, 'the recorded empty search survives on disk');

  // Scan failure: nothing recorded, live sidecar bytes untouched — a failed
  // fetch is not evidence of absence and must not advance the trail.
  //
  // The on-disk bytes are deliberately re-serialized with a DIFFERENT (but
  // equivalent) indentation first. A guard regression that starts writing on
  // this path rewrites the same object through the same serializer, so a
  // byte comparison against the writer's own output is blind to it — the
  // assertion would pass for the wrong reason. Comparing against bytes the
  // writer can never produce makes any write on this path observable.
  const parsedForReserialize = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
  fs.writeFileSync(sidecarPath, `${JSON.stringify(parsedForReserialize, null, 4)}\n`, 'utf8');
  const bytesBefore = fs.readFileSync(sidecarPath);
  const priorExitCode2 = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRegenerate([slug], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => { throw new Error('provider unreachable'); },
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: () => {},
      log: () => {},
    });
  } finally {
    process.exitCode = priorExitCode2;
  }
  assert.deepEqual(fs.readFileSync(sidecarPath), bytesBefore, 'a failed scan leaves the live sidecar byte-identical');
});

test('runRegenerate: the trail persist preserves the live plan file mode across the rename — content is replaced, permissions are not', async (t: TestContext) => {
  // The staged file lands with default permissions; without an explicit
  // preserve, the rename silently flips a customer's read-only mode choice to
  // writable. Content replacement via rename is the repo's live-plan write
  // discipline; permission replacement is not.
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const sidecarPath = path.join(target.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  fs.chmodSync(sidecarPath, 0o444);
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRegenerate([slug], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [], meta }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: () => {},
      log: () => {},
    });
  } finally {
    process.exitCode = priorExitCode;
  }
  try {
    const persisted = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
    assert.equal(persisted.source.emptySearches?.length, 1, 'the entry still lands via the rename');
    assert.equal(fs.statSync(sidecarPath).mode & 0o777, 0o444, 'the file keeps the mode the customer set');
  } finally {
    fs.chmodSync(sidecarPath, 0o644);
  }
});

const rootSkip = typeof process.getuid === 'function' && process.getuid() === 0
  ? 'requires a non-root user: a read-only directory does not block root writes'
  : false;

/**
 * The trail write is best-effort; the honest refusal is not. A workspace whose
 * plans directory cannot be written (read-only checkout, restrictive CI mount)
 * must still receive the full no-candidates refusal — the evidence trail is the
 * feature, the refusal is the contract.
 */
test('runRegenerate: an unwritable plans directory still prints the full no-candidates refusal, then discloses the unpersisted entry', { skip: rootSkip }, async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const sidecarPath = path.join(target.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const bytesBefore = fs.readFileSync(sidecarPath);
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const lines: string[] = [];
  const priorExitCode = process.exitCode;
  fs.chmodSync(sidecarPath, 0o444);
  fs.chmodSync(target.plansDir, 0o555);
  try {
    process.exitCode = undefined;
    await runRegenerate([slug], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [], meta }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(process.exitCode, 1, 'the refusal still sets the refusal exit code');
  } finally {
    fs.chmodSync(target.plansDir, 0o755);
    fs.chmodSync(sidecarPath, 0o644);
    process.exitCode = priorExitCode;
  }

  const refusal = lines[0] ?? '';
  assert.match(refusal, /^No plannable fresh candidate was found\./, 'the refusal is printed in full, not swallowed by the write');
  assert.match(refusal, /Searched the last 720h in unscoped traffic/);
  assert.match(refusal, /toward retirement/, 'the trail status the run did compute is still stated');

  // The disclosure is a separate, loud line AFTER the refusal — never a silent
  // swallow and never ahead of the contract output.
  const warning = lines[1] ?? '';
  assert.match(warning, /could not be persisted/);
  assert.ok(warning.includes(`${slug}.plan.json`), 'the warning names the path it could not write');
  assert.match(warning, /EACCES|EPERM|EROFS/, 'the warning names the underlying error');
  assert.match(warning, /this output only/, 'the warning states the search counted for this output only');
  assert.deepEqual(fs.readFileSync(sidecarPath), bytesBefore, 'a failed persist leaves the live sidecar byte-identical (staged write, never a truncate-in-place)');
});

/**
 * The atomicity half, made observable. A read-only sidecar in a WRITABLE plans
 * directory is exactly the case that separates the two implementations: a
 * truncate-in-place write opens the target and fails, while the staged
 * write-then-rename the live plan deserves puts the bytes on disk first and
 * swaps them in as one operation. If this ever starts warning, the write went
 * back to opening the customer's primary artifact in place.
 */
test('runRegenerate: the trail write is staged and renamed, so it never opens the live plan in place', { skip: rootSkip }, async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const sidecarPath = path.join(target.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const lines: string[] = [];
  const priorExitCode = process.exitCode;
  fs.chmodSync(sidecarPath, 0o444);
  try {
    process.exitCode = undefined;
    await runRegenerate([slug], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [], meta }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: () => {},
      log: (line) => lines.push(line),
    });
  } finally {
    process.exitCode = priorExitCode;
  }
  assert.equal(lines.length, 1, 'the staged write succeeded, so there is nothing to disclose');
  const persisted = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
  assert.equal(persisted.source.emptySearches?.length, 1, 'the entry landed via the rename');
  assert.equal(
    fs.existsSync(path.join(target.plansDir, `.${slug}.plan.json.tmp`)),
    false,
    'the staging file is renamed away, never left behind beside the live plans',
  );
});

test('runRegenerate --json: an unwritable plans directory keeps stdout pure JSON and routes the persistence warning to the progress channel', { skip: rootSkip }, async (t: TestContext) => {
  const target = workspace(t);
  const slug = 'order-confirmation';
  const old = neutralSessionFromSteps('old-session', 'old-user', orderConfirmationSteps('1001'));
  const jsonSidecarPath = path.join(target.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(jsonSidecarPath, `${JSON.stringify(sidecarFor(old), null, 2)}\n`, 'utf8');
  const meta: CapMetadata = {
    scanUntil: '2026-08-12T01:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  const lines: string[] = [];
  const progress: string[] = [];
  const priorExitCode = process.exitCode;
  fs.chmodSync(jsonSidecarPath, 0o444);
  fs.chmodSync(target.plansDir, 0o555);
  try {
    process.exitCode = undefined;
    await runRegenerate([slug, '--json'], {
      plansDir: target.plansDir,
      generatedTestsDir: target.generatedTestsDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({ sessions: [], meta }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
      progress: (line) => progress.push(line),
      log: (line) => lines.push(line),
    });
  } finally {
    fs.chmodSync(target.plansDir, 0o755);
    fs.chmodSync(jsonSidecarPath, 0o644);
    process.exitCode = priorExitCode;
  }
  assert.equal(lines.length, 1, 'stdout carries exactly the refusal envelope');
  const parsed = JSON.parse(lines[0] ?? '') as { error: { code: string } };
  assert.equal(parsed.error.code, 'no-candidates');
  assert.ok(
    progress.some((line) => /could not be persisted/.test(line)),
    'the persistence warning is disclosed on the progress channel so the machine surface stays parseable',
  );
});
