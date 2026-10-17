/**
 * CONFIRM probe 2 — my OWN independent A/B on the production `retirePlan` channel.
 * Written from the invariant, not copied from the landed row: asserts ALL FOUR
 * side effects the verify's A/B table compared, plus a non-vacuity pin on
 * result.kind (the landed row omits that pin).
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { retirePlan, type RetireOptions } from './cli/verbs/retire.js';
import type { Sidecar } from './sidecar.js';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const SIG = '/cart > /confirmation';

function emptySearch(searchedAt: string) {
  return {
    searchedAt,
    sinceHours: 720,
    scope: 'unscoped traffic',
    signature: SIG,
    signatureSource: 'sidecar',
    tierACandidates: 0,
    tierBVariants: 0,
    successorObservations: [],
  };
}

function liveSidecar(): Sidecar {
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
      emptySearches: [emptySearch('2026-08-10T12:00:00.000Z'), emptySearch('2026-08-15T12:00:00.000Z')],
    },
    start: '/cart',
    steps: [{ action: 'click', label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
  } as unknown as Sidecar;
}

function mkFixture(t: TestContext) {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-c5-confirm-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const reproductionsDir = path.join(root, 'tests', 'reproductions');
  const framesDir = path.join(root, '.replaytest', 'frames');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  const stateDir = path.join(root, '.replaytest', 'state');
  const triageEvidenceDir = path.join(root, '.replaytest', 'triage');
  for (const d of [plansDir, generatedTestsDir, reproductionsDir, framesDir, stateDir, triageEvidenceDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return {
    root, plansDir, generatedTestsDir, reproductionsDir, framesDir, retiredDir, triageEvidenceDir,
    specEmittedHashesPath: path.join(stateDir, 'spec-emitted-hashes.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
  };
}

function opts(fixture: ReturnType<typeof mkFixture>, slug: string): RetireOptions {
  return {
    slug,
    confirmRetire: true,
    noEvidence: false,
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
  } as RetireOptions;
}

// Two metacharacter shapes, not just the one the verify used.
for (const [slug, siblingSlug] of [
  ['v1.2-checkout', 'v1X2-checkout'],
  ['cart+pay', 'cartXpay'],
] as const) {
  test(`CONFIRM A/B — metachar slug ${slug}: sibling ${siblingSlug} untouched + unharvested`, (t: TestContext) => {
    const fixture = mkFixture(t);
    const live = liveSidecar();
    fs.writeFileSync(path.join(fixture.plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(fixture.plansDir, `${slug}.md`), `# ${live.title}\n`, 'utf8');
    fs.writeFileSync(
      path.join(fixture.generatedTestsDir, `${slug}.spec.ts`),
      `// replaytest-slug: ${slug}\nimport { test } from '@playwright/test';\n`,
      'utf8',
    );

    const ownCache = path.join(fixture.triageEvidenceDir, `${slug}.app-0123456789abcdef.report-cache.json`);
    fs.writeFileSync(ownCache, `${JSON.stringify({ kind: 'triage-report-cache', owner: 'mine' })}\n`, 'utf8');
    const siblingCache = path.join(fixture.triageEvidenceDir, `${siblingSlug}.app-0123456789abcdef.report-cache.json`);
    fs.writeFileSync(siblingCache, `${JSON.stringify({ kind: 'triage-report-cache', owner: 'SIBLING' })}\n`, 'utf8');
    const siblingPlain = path.join(fixture.triageEvidenceDir, `${siblingSlug}.json`);
    fs.writeFileSync(siblingPlain, `${JSON.stringify({ owner: 'SIBLING-PLAIN' })}\n`, 'utf8');

    const result = retirePlan(opts(fixture, slug));

    const recordPath = path.join(fixture.retiredDir, slug, 'retirement.json');
    const harvestDir = path.join(fixture.retiredDir, slug, 'state-harvest');
    const harvestContents = fs.existsSync(harvestDir) ? fs.readdirSync(harvestDir).sort() : [];
    const recordRaw = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : '';

    const ownCacheLive = fs.existsSync(ownCache);
    const siblingCacheLive = fs.existsSync(siblingCache);
    const siblingPlainLive = fs.existsSync(siblingPlain);
    // Staging removed BEFORE the asserts so a RED never leaks the temp root.
    fs.rmSync(fixture.root, { recursive: true, force: true });

    // 1. non-vacuity: the retire must actually have completed
    assert.equal(result.kind, 'retired', 'probe is vacuous unless the retire completed');
    // 2. own cache IS cleaned (the feature still works)
    assert.equal(ownCacheLive, false, "the retired journey's own report cache must be removed");
    // 3. sibling files LIVE
    assert.equal(siblingCacheLive, true, "sibling journey's report cache must be left live");
    assert.equal(siblingPlainLive, true, "sibling journey's plain triage json must be left live");
    // 4. no leak into retirement.json / state-harvest
    assert.equal(recordRaw.includes(siblingSlug), false, `retirement.json must not mention ${siblingSlug}`);
    assert.equal(
      harvestContents.some((f) => f.includes(siblingSlug)),
      false,
      'state-harvest must not contain a sibling file',
    );
  });
}
