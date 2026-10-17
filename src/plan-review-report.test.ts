import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildReplanCommand,
  collectPlanReviewReport,
} from './plan-review-report.js';

function mkPlansDir(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-review-report-'));
}

function sidecar(overrides: Record<string, unknown> = {}): object {
  const source = {
    distinctId: 'customer-42',
    sessionId: 'session-42',
    journeyIndex: 0,
    generatedAt: '2026-07-14T00:00:00.000Z',
    tool: 'replaytest@0.1.0',
    ...((overrides.source as Record<string, unknown> | undefined) ?? {}),
  };
  const { source: _source, ...rest } = overrides;
  return {
    version: 1,
    title: 'Checkout',
    source,
    start: '/checkout',
    steps: [],
    assertions: [],
    ...rest,
  };
}

function writePlan(plansDir: string, slug: string, contents: object | string): void {
  fs.writeFileSync(
    path.join(plansDir, `${slug}.plan.json`),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf8',
  );
}

test('collectPlanReviewReport: an older sidecar is flagged with its exact re-plan command', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'checkout', sidecar());

  const report = collectPlanReviewReport(plansDir, ['step']);

  assert.deepEqual(report, {
    plans: [{
      slug: 'checkout',
      kind: 'older-url-semantics',
      note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
      distinctId: 'customer-42',
      sessionId: 'session-42',
      replanCommand: 'replaytest plan customer-42 --session session-42',
    }],
    skipped: [],
  });
});

test('collectPlanReviewReport: a changed recognized parameter list is flagged', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'phase-wizard', sidecar({ source: {
    signatureSemanticsVersion: 1,
    wizardStepParamNames: ['step'],
  } }));

  const report = collectPlanReviewReport(plansDir, ['step', 'phase']);

  assert.equal(report.plans[0]?.kind, 'recognized-param-names-changed');
  assert.match(report.plans[0]?.note ?? '', /current names are \[step, phase\]/);
  assert.equal(report.plans[0]?.replanCommand, buildReplanCommand('customer-42', 'session-42'));
});

test('collectPlanReviewReport: a current sidecar and a missing plans directory need no review', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  const emptyPlansDir = mkPlansDir(t);
  writePlan(plansDir, 'current', sidecar({ source: {
    signatureSemanticsVersion: 1,
    wizardStepParamNames: ['step'],
  } }));

  assert.deepEqual(collectPlanReviewReport(plansDir, ['step']), { plans: [], skipped: [] });
  assert.deepEqual(collectPlanReviewReport(emptyPlansDir, ['step']), { plans: [], skipped: [] });
  assert.deepEqual(
    collectPlanReviewReport(path.join(plansDir, 'does-not-exist'), ['step']),
    { plans: [], skipped: [] },
  );
});

test('collectPlanReviewReport: malformed sidecars are skipped honestly, without hiding valid flags', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  writePlan(plansDir, 'broken', '{ not JSON');
  writePlan(plansDir, 'old', sidecar({ source: { distinctId: 'customer-good', sessionId: 'session-good' } }));

  const report = collectPlanReviewReport(plansDir, ['step']);

  assert.equal(report.plans.length, 1);
  assert.equal(report.plans[0]?.slug, 'old');
  assert.deepEqual(report.skipped.map(({ slug }) => slug), ['broken']);
  assert.match(report.skipped[0]?.reason ?? '', /^Invalid plan JSON \(/);
});

test('collectPlanReviewReport: quarantined .superseded.plan.json sidecars are excluded from the live review walk', (t: TestContext) => {
  const plansDir = mkPlansDir(t);
  fs.writeFileSync(
    path.join(plansDir, 'historical.superseded.plan.json'),
    JSON.stringify(sidecar()),
    'utf8',
  );

  assert.deepEqual(collectPlanReviewReport(plansDir, ['step']), { plans: [], skipped: [] });
});
