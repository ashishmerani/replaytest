import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildNoCompletedJourneysResult, buildNoCompletedJourneysMessage, buildPlanRenameFailureMessage, buildPlanStagingFailureMessage, buildSkippedJourneysNote, buildSynthesizedCommitNote, buildVerbHelpText, buildUsageError, classifyExistingSidecar, formatPlanWriteRefusal, formatPlanUnchangedLine, formatPlanWrittenLine, formatFramesTip, preflightPlanWrites, runPlan } from '../../cli.js';
import { PLANS_DIR, WORKSPACE_ROOT } from '../paths.js';
import { NAVIGATED_MULTI_CREATE_REFUSAL, NAVIGATED_PLAN_SYNTHESIS_NOTE } from '../../completion-evidence.js';
import { formatLocalTime } from '../../local-time.js';
import type { NeutralSession } from '../../neutral-session.js';
import { BATCH_TOLERANCE_MS } from '../../orphan-plans.js';
import { buildPlanCrossOriginRefusal, formatPlansDirDisplay } from './plan.js';
import { slugSurvivingRouteSegments } from '../../cli/slug.js';
import { coarseMeta, orderConfirmationSteps, neutralSessionFromSteps, writeSupersessionPlan, journeyWithStatus, mergedMultiCreateJourney, twoCompletedJourneysSession, targetSource } from './test-support.js';

test('runPlan: --help returns before the required <distinctId> is validated or the wizard-step config is read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runPlan(['--help'], {
      getWizardStepConfig: () => {
        throw new Error('getWizardStepConfig must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('plan')]);
    assert.equal(process.exitCode, undefined);
    assert.notDeepEqual(output, [buildUsageError('plan')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPlan: samples matching coarse candidates once, confirms exact signatures with scoped fetches, and writes aggregation evidence', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-'));
  const primary = neutralSessionFromSteps('primary-session', 'primary-user', orderConfirmationSteps('8f31c2'));
  const confirmed = neutralSessionFromSteps('match-session', 'match-user', orderConfirmationSteps('a1b2c3'));
  const noMatch = neutralSessionFromSteps('no-match-session', 'no-match-user', [
    { kind: 'navigation', url: 'http://localhost:8000/dashboard', at: '2026-07-09T00:00:00.000Z' },
    { kind: 'navigation', url: 'http://localhost:8000/help', at: '2026-07-09T00:00:01.000Z' },
  ]);
  let coarseCalls = 0;
  const memberFetchCalls: string[] = [];
  const logs: string[] = [];

  await runPlan(['primary-user', '--session', 'primary-session', '--force'], {
    plansDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async (distinctId, sessionId) => {
      assert.equal(distinctId, 'primary-user');
      assert.equal(sessionId, 'primary-session');
      return [primary];
    },
    fetchCoarseSessions: () => {
      coarseCalls += 1;
      return {
        sessions: [
          {
            sessionId: 'fail-session',
            distinctId: 'fail-user',
            firstTs: '2026-07-09T00:00:00.000Z',
            lastTs: '2026-07-09T00:03:00.000Z',
            navPath: [
              'http://localhost:8000/dashboard',
              'http://localhost:8000/orders/b2c3d4/pay',
              'http://localhost:8000/orders/b2c3d4/confirmation',
            ],
            submitCount: 1,
            eventCount: 5,
          },
          {
            sessionId: 'no-match-session',
            distinctId: 'no-match-user',
            firstTs: '2026-07-09T00:00:00.000Z',
            lastTs: '2026-07-09T00:02:00.000Z',
            navPath: [
              'http://localhost:8000/dashboard',
              'http://localhost:8000/orders/c3d4e5/pay',
              'http://localhost:8000/orders/c3d4e5/confirmation',
            ],
            submitCount: 1,
            eventCount: 5,
          },
          {
            sessionId: 'match-session',
            distinctId: 'match-user',
            firstTs: '2026-07-09T00:00:00.000Z',
            lastTs: '2026-07-09T00:01:00.000Z',
            navPath: [
              'http://localhost:8000/dashboard',
              'http://localhost:8000/orders/a1b2c3/pay',
              'http://localhost:8000/orders/a1b2c3/confirmation',
            ],
            submitCount: 1,
            eventCount: 5,
          },
          {
            sessionId: 'primary-session',
            distinctId: 'primary-user',
            firstTs: '2026-07-09T00:00:00.000Z',
            lastTs: '2026-07-09T00:04:00.000Z',
            navPath: [
              'http://localhost:8000/dashboard',
              'http://localhost:8000/orders/8f31c2/pay',
              'http://localhost:8000/orders/8f31c2/confirmation',
            ],
            submitCount: 1,
            eventCount: 5,
          },
        ],
        meta: coarseMeta,
      };
    },
    fetchNeutralSessionsLight: (distinctId, sessionId) => {
      memberFetchCalls.push(`${distinctId}:${sessionId}`);
      if (sessionId === 'fail-session') throw new Error('simulated scoped fetch failure');
      if (sessionId === 'no-match-session') return [noMatch];
      if (sessionId === 'match-session') return [confirmed];
      return [];
    },
  });

  assert.equal(coarseCalls, 1);
  assert.deepEqual(memberFetchCalls, [
    'fail-user:fail-session',
    'no-match-user:no-match-session',
    'match-user:match-session',
  ]);
  assert.ok(logs.includes(`Wrote orders-confirmation -> ${plansDir}/orders-confirmation.md + .plan.json`));

  const sidecar = JSON.parse(fs.readFileSync(path.join(plansDir, 'orders-confirmation.plan.json'), 'utf8'));
  const finalUrl = sidecar.assertions.find((assertion: { type: string }) => assertion.type === 'final-url');
  const pageText = sidecar.assertions.find((assertion: { type: string }) => assertion.type === 'page-shows-text');
  assert.equal(finalUrl.value, '/orders/8f31c2/confirmation');
  assert.equal(finalUrl.pattern, '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation$');
  assert.equal(pageText.enabled, true);
  assert.ok(sidecar.caveats.includes('Final page text confirmed across 1 sampled session.'));
  assert.ok(sidecar.caveats.includes('Aggregated across 3 sampled sessions of this journey (3 candidates found; 2 fetch-failures/non-matches).'));
});

test('runPlan: --sample 0 disables coarse discovery and still writes the Layer-A sidecar', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-sample-zero-'));
  const primary = neutralSessionFromSteps('primary-session', 'primary-user', orderConfirmationSteps('8f31c2'));

  await runPlan(['primary-user', '--session', 'primary-session', '--sample', '0', '--force'], {
    plansDir,
    log: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [primary],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  const sidecar = JSON.parse(fs.readFileSync(path.join(plansDir, 'orders-confirmation.plan.json'), 'utf8'));
  assert.ok(sidecar.caveats.includes('The asserted page text comes from one session — verify it is not user-specific before relying on it.'));
  assert.equal(sidecar.caveats.some((caveat: string) => caveat.includes('Aggregated across')), false);
  assert.equal(sidecar.source.signatureSemanticsVersion, 1);
  assert.deepEqual(sidecar.source.wizardStepParamNames, ['step']);
});

test('runPlan: re-planning a retired slug discloses the prior retirement record (retiredDir seam)', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-retired-'));
  const retiredDir = path.join(path.dirname(plansDir), 'retired-fixture');
  fs.mkdirSync(path.join(retiredDir, 'orders-confirmation'), { recursive: true });
  fs.writeFileSync(
    path.join(retiredDir, 'orders-confirmation', 'retirement.json'),
    `${JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', evidenceBasis: 'empty-search-trail' }, null, 2)}\n`,
    'utf8',
  );
  const primary = neutralSessionFromSteps('primary-session', 'primary-user', orderConfirmationSteps('8f31c2'));
  const logs: string[] = [];

  await runPlan(['primary-user', '--session', 'primary-session', '--sample', '0', '--force'], {
    plansDir,
    retiredDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [primary],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  const disclosure = logs.find((line) => line.includes('Re-planning proceeds — this is a fresh start.'));
  assert.ok(disclosure !== undefined, 're-plan of a retired slug must disclose the prior retirement');
  assert.match(disclosure, /This journey was retired on 2026-08-01T00:00:00\.000Z/);
  assert.match(disclosure, /evidence basis: empty-search-trail/);
});

test('runPlan: unchanged --force preserves both sidecars byte-for-byte, while real content changes rewrite and refresh generatedAt', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-write-if-changed-'));
  const jsonPath = path.join(plansDir, 'orders-confirmation.plan.json');
  const markdownPath = path.join(plansDir, 'orders-confirmation.md');
  let currentSession = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('8f31c2'));
  const planDeps = {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [currentSession],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  };
  const args = ['user-1', '--session', 'session-1', '--sample', '0', '--force'];

  await runPlan(args, { ...planDeps, log: () => undefined });
  const originalJson = fs.readFileSync(jsonPath, 'utf8');
  const originalMarkdown = fs.readFileSync(markdownPath, 'utf8');
  const originalJsonMtime = fs.statSync(jsonPath, { bigint: true }).mtimeNs;
  const originalMarkdownMtime = fs.statSync(markdownPath, { bigint: true }).mtimeNs;
  const originalGeneratedAt = JSON.parse(originalJson).source.generatedAt as string;

  const unchangedLogs: string[] = [];
  await runPlan(args, { ...planDeps, log: (line) => unchangedLogs.push(line) });
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), originalJson);
  assert.equal(fs.readFileSync(markdownPath, 'utf8'), originalMarkdown);
  assert.equal(fs.statSync(jsonPath, { bigint: true }).mtimeNs, originalJsonMtime);
  assert.equal(fs.statSync(markdownPath, { bigint: true }).mtimeNs, originalMarkdownMtime);
  assert.deepEqual(unchangedLogs, [
    `Unchanged orders-confirmation -> kept ${plansDir}/orders-confirmation.md + .plan.json`,
    formatFramesTip('orders-confirmation'),
  ]);

  // `buildSidecar` timestamps at millisecond precision; leave a clear clock
  // boundary so this assertion proves the changed pair receives a fresh stamp.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  currentSession = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('8f31c2', 'Order updated'));
  const changedLogs: string[] = [];
  await runPlan(args, { ...planDeps, log: (line) => changedLogs.push(line) });

  const changedJson = fs.readFileSync(jsonPath, 'utf8');
  const changedMarkdown = fs.readFileSync(markdownPath, 'utf8');
  assert.notEqual(changedJson, originalJson);
  assert.notEqual(changedMarkdown, originalMarkdown);
  assert.notEqual(JSON.parse(changedJson).source.generatedAt, originalGeneratedAt);
  assert.ok(fs.statSync(jsonPath, { bigint: true }).mtimeNs > originalJsonMtime);
  assert.ok(fs.statSync(markdownPath, { bigint: true }).mtimeNs > originalMarkdownMtime);
  assert.deepEqual(changedLogs, [
    formatPlanWrittenLine('orders-confirmation', plansDir),
    formatFramesTip('orders-confirmation'),
  ]);
});

test('runPlan: a partially-changed multi-journey re-plan rewrites ALL pairs as one batch — the kept-sibling never reads as superseded', async (t: TestContext) => {
  // Regression: per-artifact write-if-changed once stranded an unchanged
  // sibling outside the run's shared-generatedAt batch, and the supersession
  // detector flagged the live plan its own run had just "kept".
  // Session-granularity semantics: any change → every pair writes together.
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-batch-integrity-'));
  const shiftLater = (step: NeutralSession['steps'][number]) => ({ ...step, at: step.at.replace('T00:00:0', 'T00:00:1') });
  let currentSession = neutralSessionFromSteps('session-1', 'user-1', [
    ...orderConfirmationSteps('aaa111'),
    ...orderConfirmationSteps('bbb222').map(shiftLater),
  ]);
  const planDeps = {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [currentSession],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  };
  const args = ['user-1', '--session', 'session-1', '--sample', '0', '--force'];

  await runPlan(args, { ...planDeps, log: () => undefined });
  const firstJson = fs.readFileSync(path.join(plansDir, 'orders-confirmation.plan.json'), 'utf8');
  const firstGeneratedAt = JSON.parse(firstJson).source.generatedAt as string;

  // Change ONLY journey 2's content; journey 1 stays structurally identical.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  currentSession = neutralSessionFromSteps('session-1', 'user-1', [
    ...orderConfirmationSteps('aaa111'),
    ...orderConfirmationSteps('bbb222', 'Order updated').map(shiftLater),
  ]);
  const logs: string[] = [];
  await runPlan(args, { ...planDeps, log: (line) => logs.push(line) });

  const keptSibling = JSON.parse(fs.readFileSync(path.join(plansDir, 'orders-confirmation.plan.json'), 'utf8'));
  const changed = JSON.parse(fs.readFileSync(path.join(plansDir, 'orders-confirmation-2.plan.json'), 'utf8'));
  // Each sidecar stamps its own instant during the build, so sibling stamps
  // can straddle a millisecond boundary — the real invariant is the
  // supersession detector's own batch window, not exact equality.
  const keptStamp = Date.parse(keptSibling.source.generatedAt as string);
  const changedStamp = Date.parse(changed.source.generatedAt as string);
  assert.ok(Math.abs(keptStamp - changedStamp) < BATCH_TOLERANCE_MS, 'siblings land inside one batch window');
  assert.ok(keptStamp > Date.parse(firstGeneratedAt), 'the kept sibling received a fresh stamp');
  const rendered = logs.join('\n');
  assert.match(rendered, /Wrote orders-confirmation /);
  assert.match(rendered, /Wrote orders-confirmation-2 /);
  assert.doesNotMatch(rendered, /Superseded plans detected/, 'the kept sibling must not read as superseded');
  assert.doesNotMatch(rendered, /Unchanged /, 'a partially-changed run is not an unchanged run');
});

test('runPlan: after writing, loudly reports only superseded plans for the affected source session without renaming them', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-orphan-report-'));
  writeSupersessionPlan(
    plansDir,
    'old-dashboard',
    '/dashboard',
    '2026-07-10T00:00:00.000Z',
    { distinctId: 'plan-user', sessionId: 'plan-session' },
  );
  const session = neutralSessionFromSteps('plan-session', 'plan-user', orderConfirmationSteps('8f31c2'));
  const logs: string[] = [];

  await runPlan(['plan-user', '--session', 'plan-session', '--sample', '0'], {
    plansDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  assert.equal(fs.existsSync(path.join(plansDir, 'old-dashboard.plan.json')), true, 'plan never auto-renames an orphan');
  const rendered = logs.join('\n');
  assert.match(rendered, /⚠ Superseded plans detected \(1\)/);
  assert.match(rendered, /old-dashboard: superseded by orders-confirmation/);
  assert.ok(rendered.includes(`generated ${formatLocalTime('2026-07-10T00:00:00.000Z')} (UTC: 2026-07-10T00:00:00.000Z)`));
  assert.match(rendered, /replaytest reconcile --apply/);
});

test('runPlan: computes witnessed-login attribution from the already-segmented session and threads it to later journeys', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-auth-witness-'));
  const steps: NeutralSession['steps'] = [
    { kind: 'navigation', url: 'http://localhost:8000/login', at: '2026-07-12T00:00:00.000Z' },
    {
      kind: 'input',
      url: 'http://localhost:8000/login',
      at: '2026-07-12T00:00:01.000Z',
      target: { tag: 'input', attributes: { type: 'password' }, ancestors: [{ tag: 'form', id: 'login' }] },
    },
    {
      kind: 'submit',
      url: 'http://localhost:8000/login',
      at: '2026-07-12T00:00:02.000Z',
      target: { tag: 'button', ancestors: [{ tag: 'form', id: 'login' }] },
    },
    { kind: 'navigation', url: 'http://localhost:8000/account', at: '2026-07-12T00:00:03.000Z' },
    { kind: 'navigation', url: 'http://localhost:8000/account/write', at: '2026-07-12T00:00:04.000Z' },
    { kind: 'submit', url: 'http://localhost:8000/account/write', at: '2026-07-12T00:00:05.000Z', target: { tag: 'button' } },
    { kind: 'navigation', url: 'http://localhost:8000/account/confirmed', at: '2026-07-12T00:00:06.000Z' },
  ];
  const session = neutralSessionFromSteps('auth-session', 'auth-user', steps);

  await runPlan(['auth-user', '--session', 'auth-session', '--sample', '0'], {
    plansDir,
    log: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  const sidecars = fs
    .readdirSync(plansDir)
    .filter((filename) => filename.endsWith('.plan.json'))
    .map((filename) => JSON.parse(fs.readFileSync(path.join(plansDir, filename), 'utf8')))
    .sort((left, right) => left.source.journeyIndex - right.source.journeyIndex);
  assert.deepEqual(
    sidecars.map((sidecar) => sidecar.auth),
    [
      { witnessed: true, loginPath: '/login', shape: 'contains-login' },
      { witnessed: true, loginPath: '/login', shape: 'after-login' },
    ],
  );
  assert.deepEqual(sidecars.map((sidecar) => sidecar.performsWrites), [true, true]);
});

test('runPlan: success path with multiple journeys is byte-identical to the previous write loop and leaves no temp files behind', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-txn-success-'));
  const session = twoCompletedJourneysSession('session-1', 'user-1');
  const logs: string[] = [];

  await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
    plansDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  assert.deepEqual(logs, [
    formatPlanWrittenLine('orders-confirmation', plansDir),
    formatFramesTip('orders-confirmation'),
    formatPlanWrittenLine('orders-confirmation-2', plansDir),
    formatFramesTip('orders-confirmation-2'),
  ]);
  assert.equal(process.exitCode, undefined);

  for (const slug of ['orders-confirmation', 'orders-confirmation-2']) {
    assert.ok(fs.existsSync(path.join(plansDir, `${slug}.md`)));
    assert.ok(fs.existsSync(path.join(plansDir, `${slug}.plan.json`)));
  }

  const entries = fs.readdirSync(plansDir).sort();
  assert.deepEqual(entries, ['orders-confirmation-2.md', 'orders-confirmation-2.plan.json', 'orders-confirmation.md', 'orders-confirmation.plan.json'].sort());
});

test('runPlan: privacy probe follows the destination and skips non-git workspaces without changing stdout', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-nonrepo-probe-'));
  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('8f31c2'));
  const logs: string[] = [];
  const progress: string[] = [];
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
      // Deliberately leave workspaceRoot at its normal repository value. The
      // destination is a real non-git temp directory and must be the probe's
      // subject, not the process workspace.
      plansDir,
      log: (line) => logs.push(line),
      progress: (line) => progress.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      fetchNeutralSessionsWithDomEnrichment: async () => [session],
      fetchCoarseSessions: () => {
        throw new Error('coarse scan should be disabled');
      },
      fetchNeutralSessionsLight: () => {
        throw new Error('member fetch should be disabled');
      },
    });
    assert.equal(process.exitCode, undefined);
    assert.ok(logs.every((line) => !line.includes('privacy-workspace-not-ignored')), 'a non-repository cannot emit the assertive warning on stdout');
    assert.ok(logs.some((line) => line.startsWith('Wrote ')), 'the plan still writes after the best-effort probe skips');
    assert.deepEqual(progress, [
      '[privacy-workspace-probe-skipped] privacy-workspace-probe-skipped: could not determine whether the destination is covered by Git ignore rules; continuing without the best-effort check.',
    ]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPlan: privacy probe passes the destination itself as the git check-ignore argument', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-probe-argument-'));
  const plansDir = path.join(root, 'plans');
  const binDir = path.join(root, 'bin');
  const capturePath = path.join(root, 'git-argv.txt');
  fs.mkdirSync(binDir);
  const gitLookup = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  assert.equal(gitLookup.status, 0, gitLookup.stderr);
  const realGit = gitLookup.stdout.trim();
  assert.notEqual(realGit, '', 'the fake-git fallthrough needs the pre-PATH real git path');
  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(
    fakeGit,
    '#!/bin/sh\n' +
      'if [ "$1" = "check-ignore" ]; then\n' +
      '  printf "%s\\t%s\\n" "$PWD" "$*" >> "$REPLAYTEST_PLAN_GIT_CAPTURE"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exec "$REPLAYTEST_PLAN_REAL_GIT" "$@"\n',
  );
  fs.chmodSync(fakeGit, 0o755);

  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('8f31c2'));
  const originalPath = process.env.PATH;
  const originalCapturePath = process.env.REPLAYTEST_PLAN_GIT_CAPTURE;
  const originalRealGit = process.env.REPLAYTEST_PLAN_REAL_GIT;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    process.env.REPLAYTEST_PLAN_GIT_CAPTURE = capturePath;
    process.env.REPLAYTEST_PLAN_REAL_GIT = realGit;
    await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
      plansDir,
      log: () => {},
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      fetchNeutralSessionsWithDomEnrichment: async () => [session],
      fetchCoarseSessions: () => {
        throw new Error('coarse scan should be disabled');
      },
      fetchNeutralSessionsLight: () => {
        throw new Error('member fetch should be disabled');
      },
    });

    const records = fs.readFileSync(capturePath, 'utf8').trimEnd().split('\n');
    const expected = `${fs.realpathSync(plansDir)}\tcheck-ignore --no-index --quiet .`;
    assert.equal(records.filter((record) => record === expected).length, 1, 'the exact check-ignore record appears once regardless of call order');
    assert.equal(records.length, 1, 'no second check-ignore call can be hidden by capture truncation');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCapturePath === undefined) delete process.env.REPLAYTEST_PLAN_GIT_CAPTURE;
    else process.env.REPLAYTEST_PLAN_GIT_CAPTURE = originalCapturePath;
    if (originalRealGit === undefined) delete process.env.REPLAYTEST_PLAN_REAL_GIT;
    else process.env.REPLAYTEST_PLAN_REAL_GIT = originalRealGit;
  }
});

test('runPlan: privacy probe keeps the assertive warning only for an established unignored destination', async (t: TestContext) => {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-unignored-probe-'));
  const plansDir = path.join(workspaceRoot, '.replaytest', 'plans');
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: workspaceRoot, stdio: 'ignore' });
  assert.equal(initialized.status, 0);
  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('8f31c2'));
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
      workspaceRoot,
      plansDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      fetchNeutralSessionsWithDomEnrichment: async () => [session],
      fetchCoarseSessions: () => {
        throw new Error('coarse scan should be disabled');
      },
      fetchNeutralSessionsLight: () => {
        throw new Error('member fetch should be disabled');
      },
    });
    assert.equal(process.exitCode, undefined);
    assert.deepEqual(logs.filter((line) => line.startsWith('[privacy-workspace-not-ignored] ')), [
      '[privacy-workspace-not-ignored] privacy-workspace-not-ignored: .replaytest/ is not git-ignored; local privacy state may be committed. Add .replaytest/ to .gitignore before continuing.',
    ]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPlan: a mid-staging I/O failure leaves NO visible sidecars from ANY journey, cleans up its own temp files, and names the failed journey', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-txn-stage-fail-'));
  const session = twoCompletedJourneysSession('session-1', 'user-1');
  const logs: string[] = [];

  // Forces journey 2's markdown STAGE write to fail (EISDIR): a directory
  // sits at the exact deterministic temp path `planSidecarTmpPath` computes
  // for `orders-confirmation-2.md`, before journey 1 even starts staging.
  fs.mkdirSync(path.join(plansDir, '.orders-confirmation-2.md.tmp'));

  await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
    plansDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  assert.equal(process.exitCode, 1);
  process.exitCode = 0;

  // Nothing from EITHER journey is visible — journey 1 staged cleanly but
  // was never renamed into place, and its temp files were cleaned up too.
  for (const filename of ['orders-confirmation.md', 'orders-confirmation.plan.json', 'orders-confirmation-2.plan.json']) {
    assert.equal(fs.existsSync(path.join(plansDir, filename)), false, `${filename} must not exist`);
  }
  for (const filename of ['.orders-confirmation.md.tmp', '.orders-confirmation.plan.json.tmp', '.orders-confirmation-2.plan.json.tmp']) {
    assert.equal(fs.existsSync(path.join(plansDir, filename)), false, `leftover temp file ${filename} must be cleaned up`);
  }
  // Only the pre-planted directory (the test's own failure trigger) remains.
  assert.deepEqual(fs.readdirSync(plansDir), ['.orders-confirmation-2.md.tmp']);

  const failureLine = logs.find((line) => line.startsWith('Failed to stage plan for orders-confirmation-2:'));
  assert.ok(failureLine, 'expected a staging-failure line naming orders-confirmation-2');
  assert.ok(failureLine.includes('No sidecars were written this run.'));
  // The nothing-was-written claim and the next step that leans on it travel together.
  assert.ok(failureLine.endsWith('— nothing was written, so this is a clean retry.'));
  assert.equal(logs.some((line) => line.startsWith('Wrote ')), false, 'no journey should have logged a successful write');
});

test('runPlan: a rename-phase failure names exactly which sidecars are in place vs missing (no silent partial state)', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-txn-rename-fail-'));
  const session = twoCompletedJourneysSession('session-1', 'user-1');
  const logs: string[] = [];

  // Forces journey 2's markdown RENAME (tmp -> final) to fail: a directory
  // already occupies the exact final target path `orders-confirmation-2.md`, so
  // `fs.renameSync` throws once staging has already fully succeeded.
  fs.mkdirSync(path.join(plansDir, 'orders-confirmation-2.md'));

  await runPlan(['user-1', '--session', 'session-1', '--sample', '0'], {
    plansDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  });

  assert.equal(process.exitCode, 1);
  process.exitCode = 0;

  // Journey 1 fully committed (renamed first, before journey 2's failure).
  assert.ok(fs.existsSync(path.join(plansDir, 'orders-confirmation.md')));
  assert.ok(fs.existsSync(path.join(plansDir, 'orders-confirmation.plan.json')));
  // Journey 2 never got its plan.json, and its temp files were cleaned up —
  // no orphaned .tmp files, no half-written plan.json.
  assert.equal(fs.existsSync(path.join(plansDir, 'orders-confirmation-2.plan.json')), false);
  assert.equal(fs.existsSync(path.join(plansDir, '.orders-confirmation-2.md.tmp')), false);
  assert.equal(fs.existsSync(path.join(plansDir, '.orders-confirmation-2.plan.json.tmp')), false);

  assert.deepEqual(logs.slice(0, 2), [formatPlanWrittenLine('orders-confirmation', plansDir), formatFramesTip('orders-confirmation')]);
  const failureLine = logs[2];
  assert.ok(failureLine.startsWith('Failed to finalize plan write for orders-confirmation-2:'));
  assert.ok(failureLine.includes('In place: orders-confirmation.'));
  assert.ok(failureLine.includes('Not written: orders-confirmation-2 (not written).'));
});

test('buildPlanStagingFailureMessage: names the slug, states nothing was written this run, and says the retry is clean', () => {
  assert.equal(
    buildPlanStagingFailureMessage('confirmation-2', 'ENOENT: disk full'),
    'Failed to stage plan for confirmation-2: ENOENT: disk full. No sidecars were written this run. Check that .replaytest/plans/ is writable (disk space, permissions), then re-run `replaytest plan <distinctId>` — nothing was written, so this is a clean retry.',
  );
});

test('buildPlanRenameFailureMessage: reports committed slugs, the failing slug (with a distinct partial-write call-out), untouched slugs, and how a re-run treats what is already on disk', () => {
  const retry = 'Check .replaytest/plans/ (disk space, permissions), then re-run `replaytest plan <distinctId>` — already-committed slugs report "Unchanged" and are skipped.';
  assert.equal(
    buildPlanRenameFailureMessage([], { slug: 'confirmation', markdownRenamed: false }, [], 'EPERM'),
    `Failed to finalize plan write for confirmation: EPERM. In place: none. Not written: confirmation (not written). ${retry}`,
  );
  assert.equal(
    buildPlanRenameFailureMessage(['confirmation'], { slug: 'confirmation-2', markdownRenamed: false }, ['confirmation-3'], 'EPERM'),
    `Failed to finalize plan write for confirmation-2: EPERM. In place: confirmation. Not written: confirmation-2 (not written), confirmation-3. ${retry}`,
  );
  assert.equal(
    buildPlanRenameFailureMessage(['confirmation'], { slug: 'confirmation-2', markdownRenamed: true }, [], 'EPERM'),
    `Failed to finalize plan write for confirmation-2: EPERM. In place: confirmation. Not written: confirmation-2 (partially written: .md in place, .plan.json missing). ${retry}`,
  );
});

test('classifyExistingSidecar: same journey -> overwrite OK, even for an older sidecar with no signature', () => {
  assert.equal(
    classifyExistingSidecar(
      { kind: 'source', source: { distinctId: 'user-1', sessionId: 'session-1', journeyIndex: 0 } },
      targetSource,
    ),
    'same',
  );
});

test('classifyExistingSidecar: different sessionId or journeyIndex -> collision', () => {
  assert.equal(
    classifyExistingSidecar({ kind: 'source', source: { sessionId: 'session-2', journeyIndex: 0 } }, targetSource),
    'collision',
  );
  assert.equal(
    classifyExistingSidecar({ kind: 'source', source: { sessionId: 'session-1', journeyIndex: 1 } }, targetSource),
    'collision',
  );
});

test('classifyExistingSidecar: unreadable/invalid JSON or missing/malformed source -> unknown', () => {
  assert.equal(classifyExistingSidecar({ kind: 'error', reason: 'invalid JSON' }, targetSource), 'unknown');
  assert.equal(classifyExistingSidecar({ kind: 'source', source: undefined }, targetSource), 'unknown');
  assert.equal(classifyExistingSidecar({ kind: 'source', source: { sessionId: 'session-1' } }, targetSource), 'unknown');
  assert.equal(
    classifyExistingSidecar({ kind: 'source', source: { sessionId: 'session-1', journeyIndex: '0' } }, targetSource),
    'unknown',
  );
});

test('preflightPlanWrites: same-journey existing sidecar and fresh slug both pass', () => {
  assert.deepEqual(
    preflightPlanWrites(
      [
        {
          slug: 'invoice-confirmation',
          source: targetSource,
          existing: { kind: 'source', source: { sessionId: 'session-1', journeyIndex: 0 } },
        },
        { slug: 'customer-created', source: { sessionId: 'session-1', journeyIndex: 1 } },
      ],
      { force: false },
    ),
    { ok: true, refusals: [] },
  );
});

test('preflightPlanWrites: collision refuses the slug and the message names the slug, reason, target, and --force', () => {
  const result = preflightPlanWrites(
    [
      {
        slug: 'invoice-confirmation',
        source: targetSource,
        existing: { kind: 'source', source: { sessionId: 'other-session', journeyIndex: 0 } },
      },
    ],
    { force: false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].reason, 'collision');

  const message = formatPlanWriteRefusal(result.refusals[0]);
  assert.ok(message.includes('invoice-confirmation.plan.json'));
  assert.ok(message.includes('other-session'));
  assert.ok(message.includes('session session-1 journey 0'));
  assert.ok(message.includes('--force'));
});

test('preflightPlanWrites: unknown ownership refuses rather than silently clobbering', () => {
  const result = preflightPlanWrites(
    [
      {
        slug: 'invoice-confirmation',
        source: targetSource,
        existing: { kind: 'error', reason: 'invalid JSON' },
      },
    ],
    { force: false },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusals, [
    {
      slug: 'invoice-confirmation',
      reason: 'unknown',
      detail: 'existing sidecar ownership is unknown (invalid JSON)',
    },
  ]);
  assert.ok(formatPlanWriteRefusal(result.refusals[0]).includes('--force'));
});

test('preflightPlanWrites: --force overrides collision and unknown ownership', () => {
  const result = preflightPlanWrites(
    [
      {
        slug: 'invoice-confirmation',
        source: targetSource,
        existing: { kind: 'source', source: { sessionId: 'other-session', journeyIndex: 0 } },
      },
      {
        slug: 'customer-created',
        source: { sessionId: 'session-1', journeyIndex: 1 },
        existing: { kind: 'error', reason: 'invalid JSON' },
      },
    ],
    { force: true },
  );
  assert.deepEqual(result, { ok: true, refusals: [] });
});

test('preflightPlanWrites: all-or-nothing signal — one colliding slug makes the whole multi-journey preflight fail', () => {
  const result = preflightPlanWrites(
    [
      {
        slug: 'invoice-confirmation',
        source: targetSource,
        existing: { kind: 'source', source: { sessionId: 'session-1', journeyIndex: 0 } },
      },
      {
        slug: 'customer-created',
        source: { sessionId: 'session-1', journeyIndex: 1 },
        existing: { kind: 'source', source: { sessionId: 'other-session', journeyIndex: 0 } },
      },
    ],
    { force: false },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusals.map((refusal) => refusal.slug), ['customer-created']);
});

test('buildSkippedJourneysNote: undefined when every journey is completed', () => {
  assert.equal(buildSkippedJourneysNote([journeyWithStatus('completed'), journeyWithStatus('completed')]), undefined);
});

test('buildSkippedJourneysNote: singular "journey" for exactly one skipped', () => {
  assert.equal(
    buildSkippedJourneysNote([journeyWithStatus('completed'), journeyWithStatus('submitted')]),
    'Skipped 1 journey because it did not reach a final destination (submitted/abandoned). Choose a completed journey to create a plan.',
  );
});

test('buildSkippedJourneysNote: a SINGLE-create navigated journey is planned, so nothing is reported as skipped', () => {
  // The blanket navigated refusal is gone: this class is plannable.
  assert.equal(buildSkippedJourneysNote([journeyWithStatus('navigated')]), undefined);
});

test('buildSkippedJourneysNote: a MERGED multi-create navigated journey is skipped, out loud, with its own reason', () => {
  const merged = mergedMultiCreateJourney();
  assert.equal(
    buildSkippedJourneysNote([merged]),
    `Skipped 1 navigated journey: ${NAVIGATED_MULTI_CREATE_REFUSAL}`,
  );
  assert.match(buildSkippedJourneysNote([merged]) ?? '', /more than one input-then-new-route commit/);
});

test('buildSynthesizedCommitNote: a planned navigated journey announces the synthesized keystroke on the command line', () => {
  const note = buildSynthesizedCommitNote([journeyWithStatus('completed'), journeyWithStatus('navigated')]);
  assert.equal(note, `Planned 1 navigated journey: ${NAVIGATED_PLAN_SYNTHESIS_NOTE}`);
  assert.equal(buildSynthesizedCommitNote([journeyWithStatus('completed')]), undefined);
});

test('buildSkippedJourneysNote: plural "journeys" and counts BOTH submitted and abandoned', () => {
  assert.equal(
    buildSkippedJourneysNote([journeyWithStatus('submitted'), journeyWithStatus('abandoned')]),
    'Skipped 2 journeys because they did not reach a final destination (submitted/abandoned). Choose a completed journey to create a plan.',
  );
});

test('buildNoCompletedJourneysMessage: matches the standalone scripts\' existing wording', () => {
  // Frozen on purpose: 17 eval goldens carry this exact string, the eval
  // runner and archive validator match on it, and it stays true — the line is
  // only reached when nothing was plannable. What WAS skipped is named
  // separately by buildSkippedJourneysNote.
  assert.equal(buildNoCompletedJourneysMessage(), 'No completed journeys found in the session.');
});

test('buildNoCompletedJourneysResult: appends the next step AFTER the frozen sentence, leaving it byte-identical, and returns non-zero exit code for automation', () => {
  const nextStep = 'No automated next step from this session alone — try a different session with `replaytest sessions` (look for completed/navigated activity), or if this journey\'s traffic has moved elsewhere, `replaytest regenerate <slug>` from its existing plan searches fresh candidates.';
  assert.deepEqual(buildNoCompletedJourneysResult([journeyWithStatus('submitted')]), {
    lines: [
      'No completed journeys found in the session.',
      'Skipped 1 journey because it did not reach a final destination (submitted/abandoned). Choose a completed journey to create a plan.',
      nextStep,
    ],
    exitCode: 1,
  });
  // The no-skipped-journeys shape carries the same appended line, and the
  // frozen sentence is still line 0 in both.
  assert.deepEqual(buildNoCompletedJourneysResult([]), {
    lines: ['No completed journeys found in the session.', nextStep],
    exitCode: 1,
  });
  assert.equal(buildNoCompletedJourneysResult([]).lines[0], buildNoCompletedJourneysMessage());
});

test('formatPlanWrittenLine: names the slug and both files it produced', () => {
  assert.equal(
    formatPlanWrittenLine('invoice-confirmation', PLANS_DIR),
    'Wrote invoice-confirmation -> .replaytest/plans/invoice-confirmation.md + .plan.json',
  );
});

test('plan success lines name the directory the pair actually landed in, and the default directory keeps the long-standing wording byte-for-byte', () => {
  // The default is frozen wording: eval goldens and the CLI success-outcome
  // guard both read these lines, so an overridable directory must not cost a
  // single byte at the default.
  assert.equal(
    formatPlanUnchangedLine('invoice-confirmation', PLANS_DIR),
    'Unchanged invoice-confirmation -> kept .replaytest/plans/invoice-confirmation.md + .plan.json',
  );

  // Inside the workspace: workspace-relative, the same shape a reader can paste.
  const insideWorkspace = path.join(WORKSPACE_ROOT, 'tmp', 'plan-display', 'plans');
  assert.equal(formatPlansDirDisplay(insideWorkspace), 'tmp/plan-display/plans');
  assert.equal(
    formatPlanWrittenLine('invoice-confirmation', insideWorkspace),
    'Wrote invoice-confirmation -> tmp/plan-display/plans/invoice-confirmation.md + .plan.json',
  );
  assert.equal(
    formatPlanUnchangedLine('invoice-confirmation', insideWorkspace),
    'Unchanged invoice-confirmation -> kept tmp/plan-display/plans/invoice-confirmation.md + .plan.json',
  );

  // Outside the workspace: the absolute path, never a `..`-leading relative one
  // the reader would have to resolve by hand.
  const outsideWorkspace = path.join(os.tmpdir(), 'replaytest-plan-display-outside');
  assert.equal(formatPlansDirDisplay(outsideWorkspace), outsideWorkspace);
  assert.equal(
    formatPlanWrittenLine('invoice-confirmation', outsideWorkspace),
    `Wrote invoice-confirmation -> ${outsideWorkspace}/invoice-confirmation.md + .plan.json`,
  );
  assert.doesNotMatch(formatPlanWrittenLine('invoice-confirmation', outsideWorkspace), /\.\./);

  // The workspace root itself has no relative form to render; the absolute path
  // is the only honest answer (an empty display would emit a bare `/slug.md`).
  assert.equal(formatPlansDirDisplay(WORKSPACE_ROOT), WORKSPACE_ROOT);
});

test('formatPlansDirDisplay: a workspace-internal directory literally named `..foo` renders absolute, never a `..`-leading relative path', () => {
  // `path.relative` yields `..foo`, which the `startsWith('..')` clause (the
  // same one `displaySampledRegisterPath` carries) catches, so the absolute
  // path is returned rather than a `..foo/plans` relative a reader would have
  // to resolve by hand. The added `path.isAbsolute(relative)` guard is parity
  // with the precedent for Windows mixed-drive overrides, where `path.relative`
  // returns an absolute string that does NOT start with `..`; on POSIX
  // `path.relative` between two absolute paths never yields an absolute string,
  // so that clause is dead code here and this `..foo` case pins the clause that
  // actually fires on this host.
  const dotdotFoo = path.join(WORKSPACE_ROOT, '..foo', 'plans');
  assert.equal(formatPlansDirDisplay(dotdotFoo), dotdotFoo);
  // The default directory is unaffected by the guard: still the long-standing
  // forward-slashed relative form.
  assert.equal(formatPlansDirDisplay(PLANS_DIR), '.replaytest/plans');
});

test('formatPlansDirDisplay: the Windows drive-crossing premise behind the isAbsolute clause holds — provable via path.win32 without mocking', () => {
  // On POSIX `path.relative` between two absolute paths never returns an
  // absolute string, so the clause cannot fire on this host; on Windows a
  // different-drive override makes `relative` return the absolute target
  // itself — NOT `..`-leading — which would otherwise be separator-normalized
  // into a relative-looking rendering of an absolute path. This pins the
  // premise the clause encodes, in the platform module where it is live.
  const crossDrive = path.win32.relative('C:\\repo', 'D:\\elsewhere\\plans');
  assert.equal(path.win32.isAbsolute(crossDrive), true);
  assert.equal(crossDrive.startsWith('..'), false);
});

test('runPlan: the success line names an overridden plans directory, never the default literal', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-dir-honesty-'));
  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('8f31c2'));
  const deps = {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan should be disabled');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch should be disabled');
    },
  };
  const args = ['user-1', '--session', 'session-1', '--sample', '0'];

  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const writtenLogs: string[] = [];
    await runPlan(args, { ...deps, log: (line) => writtenLogs.push(line) });
    const unchangedLogs: string[] = [];
    await runPlan(args, { ...deps, log: (line) => unchangedLogs.push(line) });

    // Both files really are in the override, so both lines must say so.
    assert.equal(fs.existsSync(path.join(plansDir, 'orders-confirmation.md')), true);
    assert.equal(fs.existsSync(path.join(plansDir, 'orders-confirmation.plan.json')), true);
    assert.deepEqual(writtenLogs, [
      `Wrote orders-confirmation -> ${plansDir}/orders-confirmation.md + .plan.json`,
      formatFramesTip('orders-confirmation'),
    ]);
    assert.deepEqual(unchangedLogs, [
      `Unchanged orders-confirmation -> kept ${plansDir}/orders-confirmation.md + .plan.json`,
      formatFramesTip('orders-confirmation'),
    ]);
    for (const line of [...writtenLogs, ...unchangedLogs]) {
      assert.doesNotMatch(line, /\.replaytest\/plans\//);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

// ---------------------------------------------------------------------------
// The property boundary at FIRST generation: a journey that cannot be
// attributed to one site never becomes a plan by accident.
// ---------------------------------------------------------------------------

/** A completed journey that starts on one site and lands on another. */
function crossOriginSteps(orderId: string): NeutralSession['steps'] {
  return orderConfirmationSteps(orderId).map((step, index) => (
    index < 2 ? step : { ...step, url: step.url.replace('http://localhost:8000', 'http://other.test') }
  ));
}

/** A completed journey whose recorded URLs are all relative — no absolute origin was ever witnessed. */
function originlessSteps(): NeutralSession['steps'] {
  return orderConfirmationSteps('7007').map((step) => ({ ...step, url: step.url.replace('http://localhost:8000', '') }));
}

async function planWith(t: TestContext, steps: NeutralSession['steps'], argv: readonly string[]): Promise<{ logs: string[]; plansDir: string; exitCode: number | string | undefined }> {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-plan-origin-'));
  const session = neutralSessionFromSteps('origin-session', 'origin-user', steps);
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runPlan(['origin-user', '--session', 'origin-session', ...argv], {
      plansDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      fetchNeutralSessionsWithDomEnrichment: async () => [session],
      fetchCoarseSessions: () => ({ sessions: [], meta: coarseMeta }),
      fetchNeutralSessionsLight: () => [],
    });
    return { logs, plansDir, exitCode: process.exitCode };
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('runPlan: a journey spanning two properties refuses, names both origins, and writes no plan', async (t: TestContext) => {
  const { logs, plansDir, exitCode } = await planWith(t, crossOriginSteps('5005'), []);

  assert.equal(exitCode, 1);
  assert.equal(logs[0], 'Cannot plan: 1 of 1 plannable journey could not be attributed to one property.');
  assert.equal(
    logs[1],
    '- journey 1 (http://localhost:8000/dashboard -> http://other.test/orders/5005/confirmation) witnessed 2 origins: http://localhost:8000, http://other.test.',
  );
  assert.ok(logs[2].includes("can assert one property's URLs against another property's baseURL"));
  assert.ok(logs[2].includes('--allow-cross-origin only after reviewing the other property'));
  assert.equal(logs.length, 3, 'a single-journey refusal has no collateral to disclose — no extra lines');
  assert.deepEqual(fs.readdirSync(plansDir), [], 'a refused run leaves no artifact behind');
});

test('runPlan: a journey with no absolute origin at all refuses as unattributable rather than guessing a property', async (t: TestContext) => {
  const { logs, plansDir, exitCode } = await planWith(t, originlessSteps(), []);

  assert.equal(exitCode, 1);
  assert.ok(logs[1].includes('witnessed no absolute origin, so the property it belongs to is unknown.'));
  assert.equal(logs.length, 3, 'a single-journey refusal has no collateral to disclose — no extra lines');
  assert.deepEqual(fs.readdirSync(plansDir), []);
});

test('runPlan: --allow-cross-origin is the reviewed override, and the plan it writes records the entry origin', async (t: TestContext) => {
  const { logs, plansDir, exitCode } = await planWith(t, crossOriginSteps('5005'), ['--allow-cross-origin']);

  assert.equal(exitCode, undefined);
  assert.ok(logs.some((line) => line.startsWith('Wrote ')), 'the override proceeds to a normal write');
  const written = fs.readdirSync(plansDir).filter((name) => name.endsWith('.plan.json'));
  assert.equal(written.length, 1);
  const sidecar = JSON.parse(fs.readFileSync(path.join(plansDir, written[0]), 'utf8')) as { source: { origin?: string } };
  assert.equal(sidecar.source.origin, 'http://localhost:8000', 'the origin field the boundary reads already ships on every plan');
});

test('runPlan: a single-property journey is untouched by the boundary — no refusal, no extra output', async (t: TestContext) => {
  const { logs, plansDir, exitCode } = await planWith(t, orderConfirmationSteps('6006'), []);

  assert.equal(exitCode, undefined);
  assert.ok(!logs.some((line) => line.startsWith('Cannot plan:')));
  assert.equal(fs.readdirSync(plansDir).filter((name) => name.endsWith('.plan.json')).length, 1);
});

test('slug privacy screen: checks the pre-slugification route surface while preserving meaningful and opaque segment rules', () => {
  assert.deepEqual(slugSurvivingRouteSegments('http://localhost:8000/invoices/inv-1234567'), ['invoices', 'inv-1234567']);
  assert.deepEqual(slugSurvivingRouteSegments('http://localhost:8000/ref/4242424242424242x'), ['ref', '4242424242424242x']);
  assert.deepEqual(slugSurvivingRouteSegments('http://localhost:8000/users/priya@example.com'), ['users', 'priya@example.com']);
  assert.deepEqual(slugSurvivingRouteSegments('http://localhost:8000/invoices/550e8400-e29b-41d4-a716-446655440000'), ['invoices']);
});

test('runPlan: long-number and email route segments refuse before slug-derived plan writes', async (t: TestContext) => {
  const routes = [
    'http://localhost:8000/invoices/inv-1234567',
    'http://localhost:8000/ref/4242424242424242x',
    'http://localhost:8000/users/priya@example.com',
    `http://localhost:8000/recordings/${'phc_' + 'a'.repeat(30)}`,
  ];
  for (const route of routes) {
    const steps = orderConfirmationSteps('privacy-route').map((step, index, all) =>
      index === all.length - 1 ? { ...step, url: route } : step,
    );
    const { logs, plansDir, exitCode } = await planWith(t, steps, ['--sample', '0']);
    assert.equal(exitCode, 1, route);
    assert.ok(logs.some((line) => line.startsWith('privacy-disclosure-required:')), route);
    assert.deepEqual(fs.readdirSync(plansDir), [], `privacy refusal must leave no plan artifacts for ${route}`);
  }
});

/** Two plannable journeys in one session: the first stays on one property, the second hops to a second one. */
function cleanThenCrossOriginSteps(): NeutralSession['steps'] {
  return [
    ...orderConfirmationSteps('4004'),
    // Journey 2's own leading dashboard navigation is the entry-url boundary
    // `segmentJourneys` splits on — shifted 10s later to stay distinct.
    ...crossOriginSteps('5005').map((step) => ({ ...step, at: step.at.replace('T00:00:0', 'T00:00:1') })),
  ];
}

test('buildPlanCrossOriginRefusal: carries a refusal CODE from the same family regenerate refuses under', () => {
  // `plan` has no --json surface yet, so the code has no printed home — it is
  // carried on the refusal value so a later machine surface inherits it and an
  // agent can route on a stable name instead of on prose.
  const refusal = buildPlanCrossOriginRefusal(
    [{ position: 1, route: 'http://a.test/in -> http://b.test/out', origins: ['http://a.test', 'http://b.test'] }],
    1,
  );
  assert.equal(refusal.kind, 'refusal');
  assert.equal(refusal.code, 'cross-origin-journeys');
  assert.equal(refusal.exitCode, 1);
  assert.equal(
    refusal.lines.some((line) => line.startsWith('Nothing was written for this run:')),
    false,
    'with every plannable journey refused there is no collateral to disclose',
  );
});

test('runPlan: refusing one journey of two says out loud that the CLEAN journey was withheld by the same batch', async (t: TestContext) => {
  const { logs, plansDir, exitCode } = await planWith(t, cleanThenCrossOriginSteps(), []);

  assert.equal(exitCode, 1);
  assert.equal(logs[0], 'Cannot plan: 1 of 2 plannable journeys could not be attributed to one property.');
  assert.ok(logs[1].startsWith('- journey 2 ('), 'the refused journey is named by position');
  assert.equal(
    logs[3],
    "Nothing was written for this run: plan writes a session's journeys as one batch, so the other 1 plannable journey was held back too — --allow-cross-origin releases the whole run.",
  );
  assert.equal(logs.length, 4, 'headline, refused-journey line, remedy, collateral — nothing more');
  assert.deepEqual(fs.readdirSync(plansDir), [], 'all-or-nothing means the clean journey is on disk nowhere');
});

test('runPlan: a session with nothing plannable reports THAT, never a property-boundary refusal it never reached', async (t: TestContext) => {
  // The boundary is evaluated after the no-plannable-journeys path, so the 17
  // frozen empty-result goldens keep their exact wording.
  const { logs, exitCode } = await planWith(t, 
    [
      { kind: 'navigation', url: 'http://localhost:8000/dashboard', at: '2026-07-09T00:00:00.000Z' },
      { kind: 'click', url: 'http://localhost:8000/dashboard', at: '2026-07-09T00:00:01.000Z', target: { tag: 'a', text: 'Pay' } },
      { kind: 'navigation', url: 'http://other.test/checkout', at: '2026-07-09T00:00:02.000Z' },
      { kind: 'submit', url: 'http://other.test/checkout', at: '2026-07-09T00:00:03.000Z', target: { tag: 'button', text: 'Pay' } },
    ],
    [],
  );

  assert.equal(exitCode, 1);
  assert.equal(logs[0], 'No completed journeys found in the session.');
  assert.ok(!logs.some((line) => line.startsWith('Cannot plan:')));
});
