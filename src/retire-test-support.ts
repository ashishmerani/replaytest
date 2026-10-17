/**
 * Durable-retire fixture factory. Every cleanup row originates from its real
 * production writer: hash baseline, selector apply, triage evidence, and heal
 * state. Keep this committed support beside the rostered retire tests; no
 * test may depend on an ignored `tmp/` fixture.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { persistHealState } from './cli/verbs/heal.js';
import { HEAL_LATEST_SCHEMA_V2 } from './workspace-path-identity.js';
import { applyPersistedSelectorPatch } from './selector-apply.js';
import { stampEmittedSpecHash } from './spec-emitted-hashes.js';
import { acquireStateLock, releaseStateLock, type StateLockOptions } from './state-lock.js';
import { makeStateArtifactWriter } from './state-writes.js';
import { persistTriageEvidence, type PersistedTriageEvidence } from './triage-evidence.js';
import type { HealReport } from './heal.js';
import type { Sidecar } from './sidecar.js';

export const RETIRE_FIXTURE_SLUG = 'crash';
const repositoryNodeModules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

export function initializeRetireFixture(root: string, stateLockOptions: StateLockOptions = {}): void {
  if (fs.existsSync(root)) throw new Error(`refusing to clobber existing fixture: ${root}`);
  // Child CLI probes run with the fixture as CWD. This local symlink lets Node
  // resolve the repository's already-installed `tsx` without copying or
  // installing dependencies into the disposable workspace.
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(repositoryNodeModules, path.join(root, 'node_modules'), 'dir');

  const slug = RETIRE_FIXTURE_SLUG;
  const replay = path.join(root, '.replaytest');
  const plans = path.join(replay, 'plans');
  const generated = path.join(root, 'tests', 'generated');
  const repros = path.join(root, 'tests', 'reproductions');
  const frames = path.join(replay, 'frames', slug);
  const state = path.join(replay, 'state');
  const triage = path.join(state, 'triage-latest');
  for (const dir of [plans, generated, repros, frames, state, triage]) fs.mkdirSync(dir, { recursive: true });

  const sidecar: Sidecar = {
    version: 1,
    title: 'Crash fixture',
    source: {
      distinctId: 'audit-user', sessionId: 'audit-session', journeyIndex: 0,
      signature: '/cart > /confirmation', generatedAt: '2099-08-01T00:00:00.000Z', tool: 'replaytest@0.1.0',
    },
    start: '/cart',
    steps: [{ action: 'click' as const, label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url' as const, value: '/confirmation', enabled: true }],
  };
  const write = (file: string, content: string): void => fs.writeFileSync(file, content, 'utf8');
  write(path.join(plans, `${slug}.plan.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  write(path.join(plans, `${slug}.md`), '# Crash fixture\n');
  write(path.join(repros, `${slug}.repro.spec.ts`), '// default repro\n');
  write(path.join(plans, `${slug}.proposed.plan.json`), '{}\n');
  write(path.join(plans, `${slug}.proposed.md`), '# proposed\n');
  write(path.join(plans, `${slug}.proposed.diff.md`), 'diff\n');
  write(path.join(plans, `${slug}.superseded-live.2026-08-01.json`), '{}\n');
  write(path.join(plans, `${slug}.superseded-live.2026-08-01.md`), '# superseded live\n');
  write(path.join(plans, `${slug}.accepted-proposal.2026-08-01.md`), '# accepted proposal\n');
  write(path.join(plans, `${slug}.accepted-proposal.2026-08-01.diff.md`), 'diff\n');
  write(path.join(plans, `${slug}.superseded.plan.json`), '{}\n');
  write(path.join(plans, `${slug}.superseded.md`), '# superseded\n');
  write(path.join(frames, 'step-1.html'), '<html>frame</html>\n');

  // The real selector writer supplies the identity envelope. Its input evidence
  // uses the real triage writer too, not a predicate-shaped ledger row.
  const specPath = path.join(generated, `${slug}.spec.ts`);
  write(specPath, [
    "import { test } from '@playwright/test';",
    '',
    "test('crash', async ({ page }) => {",
    "  await page.locator('#old-pay').click();",
    '});',
    '',
  ].join('\n'));
  const evidence: PersistedTriageEvidence = {
    kind: 'triage-selector-freshness',
    version: 1,
    slug,
    generatedAt: '2099-08-01T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{ oldLocator: "locator('#old-pay')", freshLocator: "getByRole('button', { name: 'Pay now' })", basis: 'action-label' }],
    },
  };
  const stateLockHandle = acquireStateLock(state, 'retire', { waitMs: 0, ...stateLockOptions });
  try {
    const stateWriter = makeStateArtifactWriter({ stateLockHandle });
    persistTriageEvidence(triage, evidence, stateLockHandle);
    const applied = applyPersistedSelectorPatch({
      slug,
      apply: true,
      workspaceRoot: root,
      generatedTestsDir: generated,
      healLatestPath: path.join(state, 'heal-latest.json'),
      triageEvidenceDir: triage,
      lastRunStatePath: path.join(state, 'last-run.json'),
      reporterLastRunPath: path.join(replay, 'last-run.json'),
      selectorAppliesPath: path.join(state, 'selector-applies.json'),
      now: () => new Date('2099-08-01T00:00:00.000Z'),
      stateLockHandle,
    });
    if (applied.kind !== 'applied') throw new Error(`fixture selector writer did not apply: ${applied.kind}`);

    // The real hash writer captures the post-selector-apply spec it actually sees.
    stampEmittedSpecHash(path.join(state, 'spec-emitted-hashes.json'), root, slug, specPath, sidecar, '2099-08-01T00:00:00.000Z', stateWriter);

    // The real heal writer emits the `slugs[]` shape. The deliberately compact
    // report is sufficient because persistHealState serializes only its public
    // envelope; this never hand-authors a cleanup ledger row.
    const healReport = {
      kind: 'heal-report',
      schema: HEAL_LATEST_SCHEMA_V2,
      generatedAt: '2099-08-01T00:00:00.000Z',
      resultsDisplayPath: '.replaytest/last-run.json',
      runStartedAt: '2099-08-01T00:00:00.000Z',
      runAgeLabel: 'just now',
      window: { sinceHours: 720, sample: 1 },
      coarseScanFetchCount: 1,
      observedSpecs: [],
      runScope: { files: [`tests/generated/${slug}.spec.ts`], generatedSpecFiles: [`tests/generated/${slug}.spec.ts`], missingGeneratedSpecFiles: [] },
      suiteFingerprint: { algorithm: 'sha256', files: [], digest: '0'.repeat(64) },
      slugs: [{
        slug,
        file: `tests/generated/${slug}.spec.ts`,
        mappingSource: 'header',
        failureAttribution: { kind: 'unattributable', reason: 'fixture producer drive' },
        drift: { status: 'unknown' },
        hasSpec: true,
        result: { kind: 'error', message: 'fixture producer drive' },
      }],
      flaky: [], environmentErrors: [], notTrafficExplicable: [], outOfScope: [], unmappable: [], globalErrors: [],
    } as unknown as HealReport;
    persistHealState(healReport, {
      healLatestPath: path.join(state, 'heal-latest.json'),
      lastRunStatePath: path.join(state, 'last-run.json'),
    }, { stateLockHandle });
  } finally {
    try { releaseStateLock(stateLockHandle); } catch { /* fixture publication succeeded; this also covers Windows EPERM release shape */ }
  }
}
