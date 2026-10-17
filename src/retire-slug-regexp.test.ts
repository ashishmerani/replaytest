/**
 * Regression probe for the original escape-level drift catch.
 *
 * Drives the PRODUCTION `retirePlan` channel with a slug carrying a regex
 * metacharacter and asserts the pre-split contract: a sibling triage
 * report-cache whose name differs from the slug ONLY at the metacharacter
 * position must be left live (the `triageFilesForSlug` doc-comment invariant:
 * "The match is exact per shape, never a bare prefix").
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { retirePlan, type RetireOptions } from './cli/verbs/retire.js';
import type { Sidecar, SidecarEmptySearch } from './sidecar.js';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const SIG = '/cart > /confirmation';

function emptySearch(searchedAt: string): SidecarEmptySearch {
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

function sidecar(): Sidecar {
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
    source_emptySearches: undefined,
  } as unknown as Sidecar;
}

function liveSidecar(): Sidecar {
  const base = sidecar();
  return {
    ...base,
    source: { ...base.source, emptySearches: [emptySearch('2026-08-10T12:00:00.000Z'), emptySearch('2026-08-15T12:00:00.000Z')] },
  } as Sidecar;
}

function mkFixture(t: TestContext) {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-c5-verify-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const reproductionsDir = path.join(root, 'tests', 'reproductions');
  const framesDir = path.join(root, '.replaytest', 'frames');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  const stateDir = path.join(root, '.replaytest', 'state');
  const triageEvidenceDir = path.join(root, '.replaytest', 'triage');
  for (const d of [plansDir, generatedTestsDir, reproductionsDir, framesDir, stateDir, triageEvidenceDir]) fs.mkdirSync(d, { recursive: true });
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

test('A/B: metachar slug must not delete or harvest a sibling triage cache', (t: TestContext) => {
  const fixture = mkFixture(t);
  const slug = 'v1.2-checkout';
  const live = liveSidecar();
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.md`), `# ${live.title}\n`, 'utf8');
  fs.writeFileSync(path.join(fixture.generatedTestsDir, `${slug}.spec.ts`), `// replaytest-slug: ${slug}\nimport { test } from '@playwright/test';\n`, 'utf8');

  const ownCache = path.join(fixture.triageEvidenceDir, `${slug}.app-0123456789abcdef.report-cache.json`);
  fs.writeFileSync(ownCache, `${JSON.stringify({ kind: 'triage-report-cache', owner: 'mine' }, null, 2)}\n`, 'utf8');
  // Differs from the slug ONLY at the metacharacter position — a DIFFERENT journey.
  const siblingSlug = 'v1X2-checkout';
  const siblingCache = path.join(fixture.triageEvidenceDir, `${siblingSlug}.app-0123456789abcdef.report-cache.json`);
  fs.writeFileSync(siblingCache, `${JSON.stringify({ kind: 'triage-report-cache', owner: 'SIBLING' }, null, 2)}\n`, 'utf8');

  const result = retirePlan(opts(fixture, slug));
  console.log('PROBE result.kind =', result.kind);
  console.log('PROBE own cache exists after retire   =', fs.existsSync(ownCache));
  console.log('PROBE SIBLING cache exists after retire =', fs.existsSync(siblingCache));

  const recordPath = path.join(fixture.retiredDir, slug, 'retirement.json');
  if (fs.existsSync(recordPath)) {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { harvestedState?: { files?: Array<{ path: string }> } };
    const harvested = (record.harvestedState?.files ?? []).map((f) => f.path);
    console.log('PROBE harvested state files =', JSON.stringify(harvested));
    console.log('PROBE sibling HARVESTED (leak) =', harvested.some((p) => p.includes(siblingSlug)));
  }
  const harvestDir = path.join(fixture.retiredDir, slug, 'state-harvest');
  if (fs.existsSync(harvestDir)) console.log('PROBE state-harvest dir contents =', JSON.stringify(fs.readdirSync(harvestDir)));

  assert.equal(fs.existsSync(siblingCache), true, "a DIFFERENT journey's triage report cache must be left live");
});
