import { toolIdentifier } from '../../tool-identifier.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildVerbHelpText, buildUsageError, runFramesCommand } from '../../cli.js';
import { segmentJourneys } from '../../journeys.js';
import type { NeutralSession } from '../../neutral-session.js';
import { journeySignature } from '../../selection.js';
import type { Sidecar } from '../../sidecar.js';
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';

test('runFramesCommand: --help returns before the required <slug> is validated', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runFramesCommand(['--help'], { log: (line) => output.push(line) });
    assert.deepEqual(output, [buildVerbHelpText('frames')]);
    assert.equal(process.exitCode, undefined);
    assert.notDeepEqual(output, [buildUsageError('frames')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runFramesCommand: a refusal sets exit code 1 and prints its message', async () => {
  const originalExitCode = process.exitCode;
  const output: string[] = [];
  try {
    process.exitCode = undefined;
    await runFramesCommand(['__missing_frames_plan_for_exit_test__'], {
      plansDir: '.replaytest/plans',
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.match(output[0] ?? '', /^No plan found at \.replaytest\/plans\/__missing_frames_plan_for_exit_test__\.plan\.json/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runFramesCommand: a --steps range outside the journey exits 1 with the range refusal and writes nothing', async (t: TestContext) => {
  const baseMs = Date.UTC(2026, 6, 14, 12);
  const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
  const recorded: NeutralSession = {
    id: 'session-1',
    distinctId: 'customer-1',
    startedAt: at(0),
    endedAt: at(300),
    finalUrl: 'https://app.test/done',
    steps: [
      { kind: 'navigation', url: 'https://app.test/', at: at(0) },
      { kind: 'input', url: 'https://app.test/', at: at(100), target: { text: 'Name' } },
      { kind: 'navigation', url: 'https://app.test/done', at: at(300) },
    ],
  };
  const journey = segmentJourneys(recorded)[0];
  const plan: Sidecar = {
    version: 1,
    title: 'Enter name',
    source: {
      distinctId: 'customer-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: journeySignature(journey),
      generatedAt: at(60_000),
      tool: toolIdentifier(),
    },
    start: '/',
    steps: [],
    assertions: [],
  };
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-frames-cli-'));
  const plansDir = path.join(root, 'plans');
  const framesDir = path.join(root, 'frames');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'enter-name.plan.json'), JSON.stringify(plan), 'utf8');
  let renderCalls = 0;

  const originalExitCode = process.exitCode;
  const output: string[] = [];
  try {
    process.exitCode = undefined;
    await runFramesCommand(['enter-name', '--session', 'session-1', '--steps', '50-60'], {
      plansDir,
      framesDir,
      workspaceRoot: root,
      isFramesDirectoryIgnored: () => true,
      fetchNeutralSessions: async () => [recorded],
      fetchFullReplayStream: async () => [],
      renderCaptures: async () => {
        renderCalls += 1;
        return [];
      },
      progress: () => {},
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.deepEqual(output, [
    `Requested --steps 50-60 matches no steps in this journey (steps 1-${journey.steps.length}). Run the same command with --steps 1-${journey.steps.length}, or without --steps.`,
  ]);
  assert.equal(renderCalls, 0);
  assert.equal(fs.existsSync(framesDir), false);
});
