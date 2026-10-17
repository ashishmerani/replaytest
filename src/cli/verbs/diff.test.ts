import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDiff } from '../../cli.js';
import { REPAIR_SLUG, mkRepairLoopWorkspace, repairLoopSidecar, writeRepairLoopFixture } from './test-support.js';

test('runDiff: re-renders an existing proposal against the live plan and refuses missing artifacts honestly', (t) => {
  const previousExitCode = process.exitCode;
  try {
    const workspace = mkRepairLoopWorkspace(t);
    writeRepairLoopFixture(workspace);
    const live = repairLoopSidecar();
    const proposed = { ...live, title: 'Reschedule a patient visit with a new follow-up' };
    fs.writeFileSync(path.join(workspace.plansDir, `${REPAIR_SLUG}.proposed.plan.json`), `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');

    process.exitCode = undefined;
    const diffOutput: string[] = [];
    runDiff([REPAIR_SLUG], { plansDir: workspace.plansDir, log: (line) => diffOutput.push(line) });
    assert.equal(process.exitCode, undefined);
    assert.match(diffOutput[0] ?? '', /# Plan diff/);
    assert.match(diffOutput[0] ?? '', /Reschedule a patient visit with a new follow-up/);
    // `diff <slug>` stdout is the SAME rebuilt rendering the three
    // persisted-file callers emit — it is the one diff-reading command the
    // repair skill names, so it must not lag behind the others.
    assert.match(diffOutput[0] ?? '', /^# Plan diff\n\nChanged: 1 plan fact\n\n## Plan facts\n\n- title: /);
    assert.equal((diffOutput[0] ?? '').includes('["'), false, 'the diff verb must carry no JSON array blob');
    // Unchanged locator: no locator moved here, so there is no freshness gap to disclose
    // — the note is scoped to the case where it can actually bite, not printed
    // on every diff.
    assert.equal(diffOutput.length, 1);

    const missingProposalOutput: string[] = [];
    process.exitCode = undefined;
    runDiff(['no-proposal'], { plansDir: workspace.plansDir, log: (line) => missingProposalOutput.push(line) });
    assert.equal(process.exitCode, 1);
    assert.equal(
      missingProposalOutput[0],
      'No proposed sidecar found for "no-proposal". Run `replaytest triage no-proposal --propose` or `replaytest regenerate no-proposal` to create one.',
    );

    const noLiveSlug = 'no-live';
    fs.writeFileSync(path.join(workspace.plansDir, `${noLiveSlug}.proposed.plan.json`), `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');
    const missingLiveOutput: string[] = [];
    process.exitCode = undefined;
    runDiff([noLiveSlug], { plansDir: workspace.plansDir, log: (line) => missingLiveOutput.push(line) });
    assert.equal(process.exitCode, 1);
    assert.match(missingLiveOutput[0] ?? '', /Cannot diff "no-live": no live sidecar found/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('fresh-traffic evidence disclosure: a locator change makes `diff` disclose the fresh-traffic evidence it structurally cannot show — on BOTH channels', (t) => {
  const previousExitCode = process.exitCode;
  try {
    const workspace = mkRepairLoopWorkspace(t);
    writeRepairLoopFixture(workspace);
    const live = repairLoopSidecar();
    const proposed = repairLoopSidecar({
      steps: live.steps.map((step, index) =>
        index === 1 ? { ...step, locator: "getByRole('button', { name: 'Reschedule' })", selectorConfidence: 'confident' as const } : step,
      ),
    });
    fs.writeFileSync(path.join(workspace.plansDir, `${REPAIR_SLUG}.proposed.plan.json`), `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');

    // The freshness rule gives evidence only to callers holding a traffic
    // report, so `diff` renders a strictly SMALLER document than the
    // `.proposed.diff.md` a triage/heal run persists — while the docs point
    // agents here for "the same delta". Both renderings are honest; the
    // silence about the difference was the defect.
    process.exitCode = undefined;
    const rendered: string[] = [];
    runDiff([REPAIR_SLUG], { plansDir: workspace.plansDir, log: (line) => rendered.push(line) });
    assert.equal(rendered.length, 2, 'the rendered document and the disclosure are separate lines');
    // Shared diff rendering: the diff itself is untouched.
    assert.match(rendered[0] ?? '', /^# Plan diff\n/);
    assert.doesNotMatch(rendered[0] ?? '', /Note: this diff is re-derived/);
    assert.match(rendered[1] ?? '', /^\nNote: this diff is re-derived from the two plan files/);
    assert.match(rendered[1] ?? '', /no fresh-traffic recommendation/);
    // No persisted proposal diff on disk yet, so the note names the command
    // that produces one instead of pointing at a file that is not there.
    assert.equal((rendered[1] ?? '').includes(`Re-run \`replaytest triage ${REPAIR_SLUG} --propose\``), true);

    // With the richer artifact on disk, the note points at it by path.
    fs.writeFileSync(path.join(workspace.plansDir, `${REPAIR_SLUG}.proposed.diff.md`), '# Plan diff\n', 'utf8');
    const withPersisted: string[] = [];
    runDiff([REPAIR_SLUG], { plansDir: workspace.plansDir, log: (line) => withPersisted.push(line) });
    assert.match(
      withPersisted[1] ?? '',
      new RegExp(`Read .*${REPAIR_SLUG}\\.proposed\\.diff\\.md — the rendering written by the run that held one\\.$`),
    );
    // Regression pin for quality-claim qualification: legacy sidecars
    // record no confidence, so the note never promises a line that may be absent.
    assert.match(withPersisted[1] ?? '', /selector quality \(where the plan records one and the confidence actually moved/);

    // Regression pin: a regenerate-backed proposal wrote the SAME persisted
    // slot but held no traffic report — the note must not claim the file was
    // written by a run that held one (the evidence does not exist anywhere).
    const regenerated = {
      ...proposed,
      source: { ...proposed.source, regeneration: { sessionId: 'fresh-session', regeneratedAt: '2026-08-16T00:00:00.000Z' } },
    };
    fs.writeFileSync(path.join(workspace.plansDir, `${REPAIR_SLUG}.proposed.plan.json`), `${JSON.stringify(regenerated, null, 2)}\n`, 'utf8');
    const fromRegenerate: string[] = [];
    runDiff([REPAIR_SLUG], { plansDir: workspace.plansDir, log: (line) => fromRegenerate.push(line) });
    assert.match(fromRegenerate[1] ?? '', /came from `replaytest regenerate`, which holds no traffic report — no fresh-traffic recommendation exists for it\.$/);
    assert.doesNotMatch(fromRegenerate[1] ?? '', /held one/);

    // Structured disclosure: the agent channel gets the same disclosure IN the struct, so an
    // agent branching on `--json` is not the one consumer left in the dark.
    const jsonOutput: string[] = [];
    runDiff([REPAIR_SLUG, '--json'], { plansDir: workspace.plansDir, log: (line) => jsonOutput.push(line) });
    const parsed = JSON.parse(jsonOutput[0] ?? '') as { note?: string };
    assert.deepEqual(Object.keys(parsed).sort(), ['diff', 'note', 'slug']);
    assert.match(parsed.note ?? '', /^Note: this diff is re-derived from the two plan files/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runDiff --json: emits the same SidecarDiff struct the propose/regenerate envelopes carry, and a structured refusal', (t) => {
  const previousExitCode = process.exitCode;
  try {
    const workspace = mkRepairLoopWorkspace(t);
    writeRepairLoopFixture(workspace);
    const live = repairLoopSidecar();
    const proposed = { ...live, title: 'Reschedule a patient visit with a new follow-up' };
    fs.writeFileSync(path.join(workspace.plansDir, `${REPAIR_SLUG}.proposed.plan.json`), `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');

    process.exitCode = undefined;
    const jsonOutput: string[] = [];
    runDiff([REPAIR_SLUG, '--json'], { plansDir: workspace.plansDir, log: (line) => jsonOutput.push(line) });
    assert.equal(process.exitCode, undefined);
    const parsed = JSON.parse(jsonOutput[0] ?? '') as {
      slug: string;
      diff: {
        fields: Array<{ field: string; before: unknown; after: unknown }>;
        steps: { added: unknown[]; removed: unknown[]; changed: unknown[] };
        assertions: { added: unknown[]; removed: unknown[]; changed: unknown[] };
        summary: { planFacts: number; empty: boolean };
      };
    };
    assert.deepEqual(Object.keys(parsed).sort(), ['diff', 'slug']);
    assert.equal(parsed.slug, REPAIR_SLUG);
    assert.deepEqual(Object.keys(parsed.diff).sort(), ['assertions', 'fields', 'steps', 'summary']);
    assert.deepEqual(parsed.diff.fields.map((change) => change.field), ['title']);
    assert.equal(parsed.diff.summary.planFacts, 1);
    assert.equal(parsed.diff.summary.empty, false);

    process.exitCode = undefined;
    const refusalOutput: string[] = [];
    runDiff(['no-proposal', '--json'], { plansDir: workspace.plansDir, log: (line) => refusalOutput.push(line) });
    assert.equal(process.exitCode, 1);
    const refusal = JSON.parse(refusalOutput[0] ?? '') as { error: { code: string; message: string } };
    assert.equal(refusal.error.code, 'missing-sidecar');
    assert.match(refusal.error.message, /No proposed sidecar found for "no-proposal"/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

/**
 * A customer who has been searching fresh traffic for days and lands here
 * gets the recorded state named, not a bare loop-back. The count is the shared
 * qualifying count, so this door and `regenerate` never report two different
 * numbers for one trail.
 */
test('runDiff: the no-proposal refusal names the live plan\'s empty-search trail when it carries one', (t) => {
  const previousExitCode = process.exitCode;
  try {
    const workspace = mkRepairLoopWorkspace(t);
    const live = repairLoopSidecar();
    live.source.emptySearches = [
      {
        searchedAt: '2026-08-10T00:00:00.000Z',
        sinceHours: 720,
        scope: 'unscoped traffic',
        signature: live.source.signature!,
        signatureSource: 'sidecar',
        tierACandidates: 0,
        tierBVariants: 0,
        successorObservations: [],
      },
      {
        searchedAt: '2026-08-11T02:00:00.000Z',
        sinceHours: 24,
        scope: 'unscoped traffic',
        signature: live.source.signature!,
        signatureSource: 'sidecar',
        tierACandidates: 0,
        tierBVariants: 0,
        successorObservations: [],
      },
    ];
    writeRepairLoopFixture(workspace, { sidecar: live });

    process.exitCode = undefined;
    const output: string[] = [];
    runDiff([REPAIR_SLUG], { plansDir: workspace.plansDir, log: (line) => output.push(line) });
    assert.equal(process.exitCode, 1);
    assert.equal(
      output[0],
      `No proposed sidecar found for "${REPAIR_SLUG}". This path has 1 of 2 qualifying empty searches toward retirement (2 recorded in total; 1 did not qualify). Run \`replaytest triage ${REPAIR_SLUG} --propose\` or \`replaytest regenerate ${REPAIR_SLUG}\` to create one.`,
    );
  } finally {
    process.exitCode = previousExitCode;
  }
});
