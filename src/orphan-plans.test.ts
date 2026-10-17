import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectOrphanPlansReport } from './orphan-plans.js';

const OLD = '2026-07-12T15:28:07.452Z';
const CURRENT = '2026-07-14T16:52:17.283Z';

function mkPlansDir(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-orphan-plans-'));
}

function sidecar(
  signature: string,
  generatedAt: string,
  sourceOverrides: Record<string, unknown> = {},
): object {
  return {
    version: 1,
    title: 'Recorded journey',
    source: {
      distinctId: '019f56e3-7338-user',
      sessionId: '019f56e3-733e-session',
      journeyIndex: 0,
      signature,
      generatedAt,
      tool: 'replaytest@0.1.0',
      ...sourceOverrides,
    },
    start: '/login.html',
    steps: [],
    assertions: [],
  };
}

function writePlan(plansDir: string, slug: string, value: object | string): void {
  fs.writeFileSync(
    path.join(plansDir, `${slug}.plan.json`),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

function writeLiveTrio(plansDir: string): void {
  // The live broken corpus shape, replicated as temp-dir evidence rather than
  // read from the workspace's read-only .replaytest/ directory.
  writePlan(plansDir, 'account-billing', sidecar('/login.html > /account > /account/billing.html', OLD));
  writePlan(plansDir, 'account-index', sidecar('/login.html > /account', CURRENT));
  writePlan(
    plansDir,
    'account-billing-confirmation',
    sidecar('/account/billing.html > /account/billing-confirmation.html', CURRENT),
  );
}

test('collectOrphanPlansReport: the live-trio shape detects the older overlapping sidecar and preserves current-batch siblings', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writeLiveTrio(plansDir);

  const report = collectOrphanPlansReport(plansDir);

  assert.deepEqual(report.plans, [{
    slug: 'account-billing',
    distinctId: '019f56e3-7338-user',
    sessionId: '019f56e3-733e-session',
    generatedAt: OLD,
    supersededBy: ['account-billing-confirmation', 'account-index'],
    supersededByGeneratedAt: CURRENT,
    reconcileCommand: 'replaytest reconcile --apply',
  }]);
  assert.deepEqual(report.skipped, []);
});

test('collectOrphanPlansReport: equal generatedAt values are current-batch siblings, never superseded', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'sibling-a', sidecar('/login > /account', CURRENT));
  writePlan(plansDir, 'sibling-b', sidecar('/account > /billing', CURRENT));

  assert.deepEqual(collectOrphanPlansReport(plansDir), { plans: [], skipped: [] });
});

test('collectOrphanPlansReport: sub-tolerance generatedAt skew (the committed 1ms showcase pair) is a sibling relation, never superseded', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  // A prior false positive is replicated: one plan run stamped each sidecar
  // as written — 1ms apart — and both signatures share only the root '/'.
  writePlan(plansDir, 'invoice-confirmation', sidecar('/ > /invoice.html > /invoice-confirmation.html', '2026-07-09T16:52:54.359Z'));
  writePlan(plansDir, 'customer-created', sidecar('/ > /customer-new.html > /customer-created.html', '2026-07-09T16:52:54.360Z'));

  assert.deepEqual(collectOrphanPlansReport(plansDir), { plans: [], skipped: [] });
});

test('collectOrphanPlansReport: a shared root "/" alone is never overlap, but a shared non-root segment still is', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'old-root-only', sidecar('/ > /pricing.html', OLD));
  writePlan(plansDir, 'current-other-flow', sidecar('/ > /signup.html', CURRENT));

  assert.deepEqual(collectOrphanPlansReport(plansDir).plans, []);

  writePlan(plansDir, 'old-real-overlap', sidecar('/ > /signup.html > /welcome.html', OLD));
  assert.deepEqual(
    collectOrphanPlansReport(plansDir).plans.map((plan) => plan.slug),
    ['old-real-overlap'],
  );
});

test('collectOrphanPlansReport: byte-identical signatures overlap even when the whole signature is the bare root "/"', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'old-home', sidecar('/', OLD));
  writePlan(plansDir, 'current-home', sidecar('/', CURRENT));

  assert.deepEqual(
    collectOrphanPlansReport(plansDir).plans.map((plan) => plan.slug),
    ['old-home'],
  );
});

test('collectOrphanPlansReport: an older sidecar with no shared canonical segment is not guessed to be superseded', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'old-settings', sidecar('/settings > /settings/profile', OLD));
  writePlan(plansDir, 'current-checkout', sidecar('/checkout > /confirmation', CURRENT));

  assert.deepEqual(collectOrphanPlansReport(plansDir), { plans: [], skipped: [] });
});

test('collectOrphanPlansReport: every older overlapping generation is superseded, not only the immediately previous one', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'oldest', sidecar('/login > /account > /billing', '2026-07-10T00:00:00.000Z'));
  writePlan(plansDir, 'previous', sidecar('/account > /profile', OLD));
  writePlan(plansDir, 'current', sidecar('/account > /home', CURRENT));

  const report = collectOrphanPlansReport(plansDir);
  assert.deepEqual(report.plans.map((plan) => [plan.slug, plan.supersededBy]), [
    ['oldest', ['current']],
    ['previous', ['current']],
  ]);
});

test('collectOrphanPlansReport: unreadable/invalid sidecars become skipped evidence without hiding valid findings', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writeLiveTrio(plansDir);
  writePlan(plansDir, 'broken', '{ this is not JSON');

  const report = collectOrphanPlansReport(plansDir);
  assert.equal(report.plans.length, 1);
  assert.deepEqual(report.skipped.map((entry) => entry.slug), ['broken']);
  assert.match(report.skipped[0]?.reason ?? '', /^Invalid plan JSON \(/);
});

test('collectOrphanPlansReport: proposed and already-superseded files are ignored exactly like non-live sidecars', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'current', sidecar('/account > /home', CURRENT));
  fs.writeFileSync(
    path.join(plansDir, 'old.proposed.plan.json'),
    JSON.stringify(sidecar('/account > /profile', OLD)),
    'utf8',
  );
  fs.writeFileSync(
    path.join(plansDir, 'older.superseded.plan.json'),
    JSON.stringify(sidecar('/account > /billing', '2026-07-10T00:00:00.000Z')),
    'utf8',
  );

  assert.deepEqual(collectOrphanPlansReport(plansDir), { plans: [], skipped: [] });
});
