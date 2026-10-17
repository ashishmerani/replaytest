/**
 * Landed as a battery row: the ANCHORING half of the exact-match invariant.
 * Sibling journey whose slug SUFFIX-CONTAINS the retired slug:
 *   retired slug   = 'checkout'
 *   sibling  slug  = 'guest-checkout'   (a DIFFERENT journey)
 * With `^`/`$` present the sibling is safe; with anchoring lost it is matched.
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
const emptySearch = (searchedAt: string) => ({
  searchedAt, sinceHours: 720, scope: 'unscoped traffic', signature: SIG,
  signatureSource: 'sidecar', tierACandidates: 0, tierBVariants: 0, successorObservations: [],
});

function liveSidecar(): Sidecar {
  return {
    version: 1,
    title: 'Checkout confirmation',
    source: {
      distinctId: 'user-1', sessionId: 'session-1', journeyIndex: 0, signature: SIG,
      generatedAt: '2026-07-01T12:00:00.000Z', tool: 'replaytest@0.1.0',
      emptySearches: [emptySearch('2026-08-10T12:00:00.000Z'), emptySearch('2026-08-15T12:00:00.000Z')],
    },
    start: '/cart',
    steps: [{ action: 'click', label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
  } as unknown as Sidecar;
}

test('anchoring: a sibling journey whose slug ENDS WITH the retired slug must be left live', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-c5-anchor-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const stateDir = path.join(root, '.replaytest', 'state');
  const triageEvidenceDir = path.join(root, '.replaytest', 'triage');
  for (const d of [plansDir, generatedTestsDir, path.join(root, 'tests', 'reproductions'), path.join(root, '.replaytest', 'frames'), stateDir, triageEvidenceDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const slug = 'checkout';
  const siblingSlug = 'guest-checkout';
  const live = liveSidecar();
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(plansDir, `${slug}.md`), `# ${live.title}\n`, 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, `${slug}.spec.ts`), `// replaytest-slug: ${slug}\nimport { test } from '@playwright/test';\n`, 'utf8');

  const ownCache = path.join(triageEvidenceDir, `${slug}.app-0123456789abcdef.report-cache.json`);
  fs.writeFileSync(ownCache, '{"owner":"mine"}\n', 'utf8');
  const siblingCache = path.join(triageEvidenceDir, `${siblingSlug}.app-0123456789abcdef.report-cache.json`);
  fs.writeFileSync(siblingCache, '{"owner":"SIBLING"}\n', 'utf8');

  const opts = {
    slug, confirmRetire: true, noEvidence: false, plansDir, generatedTestsDir,
    reproductionsDir: path.join(root, 'tests', 'reproductions'),
    framesDir: path.join(root, '.replaytest', 'frames'),
    retiredDir: path.join(root, '.replaytest', 'retired'),
    workspaceRoot: root,
    specEmittedHashesPath: path.join(stateDir, 'spec-emitted-hashes.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    triageEvidenceDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    now: () => NOW,
  } as RetireOptions;

  const result = retirePlan(opts);
  const recordPath = path.join(root, '.replaytest', 'retired', slug, 'retirement.json');
  const recordRaw = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : '';
  const ownCacheLive = fs.existsSync(ownCache);
  const siblingCacheLive = fs.existsSync(siblingCache);
  // Staging removed BEFORE the asserts so a RED never leaks the temp root.
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.kind, 'retired');
  assert.equal(ownCacheLive, false, "own cache must be cleaned");
  assert.equal(siblingCacheLive, true, "guest-checkout's cache must be left live");
  assert.equal(recordRaw.includes(siblingSlug), false, 'no sibling leak into retirement.json');
});
