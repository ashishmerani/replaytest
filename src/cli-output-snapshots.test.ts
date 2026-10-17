import { tempDirForFile } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runGaps, runRegenerate, runSessions, runTriage } from './cli.js';
import { displayPath } from './cli/sidecar-io.js';
import { buildHandFinishedDisclosure } from './hand-finished.js';
import { DashboardLocalStore } from './dashboard/local-store.js';
import type { NeutralSession, NeutralStep, NeutralTarget } from './neutral-session.js';
import type { Sidecar } from './sidecar.js';
import { captureProcessStderr, captureProcessStdout } from './cli/verbs/test-support.js';

process.env.TZ = 'UTC';

// Customer-facing paths render workspace-relative. These fixtures instead use
// a unique OS-temp root, so snapshots normalize only that nondeterministic
// test root while the production relative-path branch is pinned below.
const FIXTURE_ROOT = tempDirForFile(path.join(os.tmpdir(), 'replaytest-cli-output-snapshots-'));
// Set only when intentionally refreshing this test's inline snapshots.
const REFREEZE_CLI_OUTPUT_SNAPSHOTS = 'REPLAYTEST_REFREEZE_CLI_OUTPUT_SNAPSHOTS';

test('CLI output snapshot fixtures live outside the process cwd', () => {
  const relative = path.relative(process.cwd(), FIXTURE_ROOT);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), true, `fixture root must stay outside process.cwd(): ${FIXTURE_ROOT}`);
});

test('CLI customer-facing paths remain workspace-relative instead of leaking an absolute path', () => {
  const customerPath = path.join(process.cwd(), 'tests', 'generated', 'snapshot-flow.spec.ts');
  assert.equal(displayPath(customerPath), 'tests/generated/snapshot-flow.spec.ts');
});

test('CLI output snapshot: the shared hand-finished disclosure copy is pinned', () => {
  assertSnapshot('handFinishedDisclosure', buildHandFinishedDisclosure('snapshot-flow'));
});

test('captureProcessStderr captures strings and forwards binary reporter frames untouched', async () => {
  const realWrite = process.stderr.write;
  const reporterFrame = Buffer.from([0xff, 0x0f, 0x00]);
  const forwarded: Buffer[] = [];
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string' && Buffer.from(chunk).equals(reporterFrame)) {
      forwarded.push(Buffer.from(chunk));
      return true;
    }
    return (realWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const captured = await captureProcessStderr(async () => {
      process.stderr.write(reporterFrame);
      process.stderr.write('stderr text');
    });
    assert.equal(captured, 'stderr text');
    assert.deepEqual(forwarded, [reporterFrame]);
  } finally {
    process.stderr.write = realWrite;
  }
});

test('captureProcessStdout refuses overlapping capture attempts and restores the outer capture', async () => {
  let releaseOuter = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocker = new Promise<void>((resolve) => { releaseOuter = resolve; });
  const outer = captureProcessStdout(async () => {
    markStarted();
    await blocker;
  });
  await started;
  try {
    await assert.rejects(
      captureProcessStdout(async () => {}),
      { name: 'ProcessOutputCaptureInProgressError', message: 'captureProcessStdout is already in progress' },
    );
  } finally {
    releaseOuter();
    await outer;
  }
});

test('captureProcessStdout preserves nested LIFO captures', async () => {
  let inner = '';
  const outer = await captureProcessStdout(async () => {
    process.stdout.write('outer-before|');
    inner = await captureProcessStdout(async () => {
      process.stdout.write('inner-only');
    });
    process.stdout.write('outer-after');
  });

  assert.equal(inner, 'inner-only');
  assert.equal(outer, 'outer-before|outer-after');
});

test('captureProcessStderr preserves nested LIFO captures', async () => {
  let inner = '';
  const outer = await captureProcessStderr(async () => {
    process.stderr.write('outer-before|');
    inner = await captureProcessStderr(async () => {
      process.stderr.write('inner-only');
    });
    process.stderr.write('outer-after');
  });

  assert.equal(inner, 'inner-only');
  assert.equal(outer, 'outer-before|outer-after');
});

test('captureProcessStdout removes its own token when a floating nested capture unwinds later', async () => {
  const originalWrite = process.stdout.write;
  let releaseInner = () => {};
  const blocker = new Promise<void>((resolve) => { releaseInner = resolve; });
  let inner: Promise<string> | undefined;
  try {
    await captureProcessStdout(async () => {
      inner = captureProcessStdout(async () => {
        await blocker;
        process.stdout.write('inner-after-outer');
      });
    });
    releaseInner();
    assert.equal(await inner, 'inner-after-outer');
    assert.equal(process.stdout.write, originalWrite, 'out-of-order nested unwind must restore the original stdout writer');
  } finally {
    releaseInner();
    await inner;
    process.stdout.write = originalWrite;
  }
});

test('captureProcessStderr removes its own token when a floating nested capture unwinds later', async () => {
  const originalWrite = process.stderr.write;
  let releaseInner = () => {};
  const blocker = new Promise<void>((resolve) => { releaseInner = resolve; });
  let inner: Promise<string> | undefined;
  try {
    await captureProcessStderr(async () => {
      inner = captureProcessStderr(async () => {
        await blocker;
        process.stderr.write('inner-after-outer');
      });
    });
    releaseInner();
    assert.equal(await inner, 'inner-after-outer');
    assert.equal(process.stderr.write, originalWrite, 'out-of-order nested unwind must restore the original stderr writer');
  } finally {
    releaseInner();
    await inner;
    process.stderr.write = originalWrite;
  }
});

const FIXED_NOW = Date.parse('2026-08-10T12:00:00.000Z');

const SNAPSHOTS = {
  handFinishedDisclosure: 'ⓘ hand-finished spec (declared) — do not run "replaytest scaffold snapshot-flow --force": it would overwrite hand-authored work. Parity is owned by human review; if a deliberate re-scaffold is intended, remove the hand-finished declaration first.',
  sessionsTable: `Exact scan of 1 session.
rank  sessions  status              distinct id                           signature
   1         1  Completed           sessions-customer                     /dashboard > /orders/:id/pay > /orders/:id/confirmation
1 completed · 0 navigated
Navigated counts are a minimum, not a total. When one session creates several records back to back, those creates can merge into a single journey and be counted once. Splitting them apart is not built yet, so a low Navigated count is never on its own evidence that this class is rare.
Status is an aggregate signal for the ranked journey; an individual session may resolve differently at plan time.
Next: replaytest plan <distinct id> — turn a completed row into a reviewable plan (then: replaytest scaffold <slug>).`,
  sessionsJson: `{
  "provenance": "exact",
  "meta": null,
  "size": {
    "total": 1,
    "shown": 1,
    "truncated": false
  },
  "journeys": [
    {
      "rank": 1,
      "signature": "/dashboard > /orders/:id/pay > /orders/:id/confirmation",
      "sessionCount": 1,
      "provenance": "exact",
      "status": "completed",
      "completionEvidence": "submit-then-nav",
      "representativeDistinctId": "sessions-customer",
      "representativeSessionId": "sessions-recording",
      "representativeStartedAt": "2026-08-01T09:00:00.000Z",
      "representativeEndedAt": "2026-08-01T09:00:05.000Z",
      "examplePaths": [
        "/dashboard > /orders/1001/pay > /orders/1001/confirmation"
      ],
      "planned": false,
      "tested": false,
      "coverage": {
        "planned": false,
        "tested": false
      },
      "replay": {
        "representative": true,
        "watchUrl": "https://us.posthog.com/project/snapshot-project/replay/sessions-recording",
        "availability": "unknown",
        "note": "Watch URL is for this row's representative session. Unavailable can mean recording was off or expired; unknown is not evidence of absence."
      }
    }
  ],
  "completionCounts": {
    "completed": 1,
    "navigated": 0,
    "submitted": 0,
    "abandoned": 0,
    "submitThenNav": 1,
    "commitThenNewRoute": 0
  },
  "completionCoverage": {
    "sessionsScanned": 1,
    "totalSessionsAtScanStart": 1,
    "capped": false
  },
  "scanMode": {
    "kind": "exact",
    "sessions": 1,
    "source": "live"
  },
  "signalAssessability": {
    "rageClicks": {
      "assessed": true,
      "tier": "exact-event-scan",
      "note": "Timestamps and target detail are available when witnessed."
    },
    "consoleErrors": {
      "assessed": false,
      "note": "Needs the per-session recording fetch; discovery rankings do not make that fetch."
    },
    "exceptions": {
      "assessed": true,
      "tier": "exact-event-scan",
      "note": "Time-window-attributed only for the representative journey."
    },
    "note": "Rage-click evidence is assessed by the exact event scan or the coarse aggregate. Console-error counts need the per-session recording fetch and are not assessed in discovery rankings; exception evidence is exact-scan-only."
  },
  "suiteScan": {
    "state": "complete",
    "filesScanned": 0,
    "capped": false,
    "maxFiles": 500,
    "maxFileBytes": 524288,
    "note": "Suite-match heuristic: a source scan only reports a possible match; it never proves behavioral coverage."
  },
  "replayAvailability": {
    "state": "not-requested",
    "note": "Watch URL is for this row's representative session. Unavailable can mean recording was off or expired; unknown is not evidence of absence."
  }
}`,
  sessionsRefusal: 'Cannot use --replay-availability without --json: the bounded live availability check only annotates JSON replay links, so in table mode it would silently do nothing. Add --json to run it, or drop --replay-availability.',
  sessionsStoredTable: `rank  sessions  status              distinct id                           signature
   1         1  Completed           stored-customer                       /dashboard > /orders/:id/pay > /orders/:id/confirmation
Status is an aggregate signal for the ranked journey; an individual session may resolve differently at plan time.
Next: replaytest plan <distinct id> — turn a completed row into a reviewable plan (then: replaytest scaffold <slug>).
Stored dashboard snapshot — fetched Aug 10, 2026, 11:00 AM UTC (raw UTC: 2026-08-10T11:00:00.000Z).
Stored snapshot key: ["sessions","--json"]|wizardStepParams=[]|limit=undefined. No PostHog contact.`,
  sessionsStoredJson: `{
  "provenance": "exact",
  "meta": null,
  "journeys": [
    {
      "rank": 1,
      "signature": "/dashboard > /orders/:id/pay > /orders/:id/confirmation",
      "sessionCount": 1,
      "provenance": "exact",
      "status": "completed",
      "completionEvidence": "submit-then-nav",
      "representativeDistinctId": "stored-customer",
      "representativeSessionId": "stored-recording",
      "representativeStartedAt": "2026-08-01T09:00:00.000Z",
      "representativeEndedAt": "2026-08-01T09:00:05.000Z",
      "examplePaths": [
        "/dashboard > /orders/4004/pay > /orders/4004/confirmation"
      ],
      "planned": false,
      "tested": false,
      "coverage": {
        "planned": false,
        "tested": false
      },
      "replay": {
        "representative": true,
        "watchUrl": "https://us.posthog.com/project/snapshot-project/replay/stored-recording",
        "availability": "unknown",
        "note": "Watch URL is for this row's representative session. Unavailable can mean recording was off or expired; unknown is not evidence of absence."
      }
    }
  ],
  "suiteScan": {
    "state": "complete",
    "filesScanned": 0,
    "capped": false,
    "maxFiles": 500,
    "maxFileBytes": 524288,
    "note": "Suite-match heuristic: a source scan only reports a possible match; it never proves behavioral coverage."
  },
  "storedSnapshot": {
    "source": "dashboard-last-scan",
    "contactedPostHog": false,
    "filterKey": "[\\"sessions\\",\\"--json\\"]|wizardStepParams=[]|limit=undefined",
    "payloadSchemaVersion": 6,
    "identity": {
      "host": "us.posthog.com",
      "projectId": "snapshot-project"
    },
    "fetchedAt": "2026-08-10T11:00:00.000Z",
    "fetchedAtLocal": "Aug 10, 2026, 11:00 AM UTC"
  },
  "coverageDelta": {
    "newlyPlanned": 0,
    "newlyTested": 0,
    "unPlanned": 0,
    "unTested": 0
  },
  "size": {
    "total": 1,
    "shown": 1,
    "truncated": false
  },
  "replayAvailability": {
    "state": "not-requested",
    "note": "Watch URL is for this row's representative session. Unavailable can mean recording was off or expired; unknown is not evidence of absence."
  }
}`,
  sessionsShapeTable: `Exact scan of 1 session.
rank  sessions  status              confidence     distinct id                           signature
   1         1  Completed           Seen directly  sessions-customer                     /dashboard > /orders/:id/pay > /orders/:id/confirmation
1 completed · 0 navigated
Navigated counts are a minimum, not a total. When one session creates several records back to back, those creates can merge into a single journey and be counted once. Splitting them apart is not built yet, so a low Navigated count is never on its own evidence that this class is rare.
Status is an aggregate signal for the ranked journey; an individual session may resolve differently at plan time.
Next: replaytest plan <distinct id> — turn a completed row into a reviewable plan (then: replaytest scaffold <slug>).
Shape filter: form-submit-signal [Seen directly] — We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)`,
  gapsTable: `Exact scan of 1 session.
What your users do vs. what your tests cover
Each section looks at one kind of real user traffic.
Rows are ranked by how many user sessions did the same thing — Rank 1 = what users do most.
Start at the top of "No test yet": pick a row, copy its command, and turn that real journey into a test.
Traffic scanned: Includes user traffic up to an unavailable timestamp (from the last completed scan).
Your existing tests: We checked your existing tests (0 files scanned).
Newest sessions: No spot-check sample yet — take one below.

Form submissions
  Users who submitted a form: sign-ups, checkouts, saves.
  Before you build: A test of this journey will submit form data when it runs. Watch one session replay first, and point tests at a staging site or seeded test data — never production.
  How to read the confidence labels:
    Seen directly: From the detailed scan — we saw this happen at this exact step. (JSON value: \`exact\`)
    Strong hint: From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: \`coarse-likely\`)
    Couldn't check: The evidence needed for this check wasn't available for this row. (JSON value: \`not-assessed\`)
  We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)
  These users submitted a form at some point in their visit — we couldn't tell whether it was on this exact page.
  We couldn't check this row for form submissions.
  No test yet (ranked — start here):
    #1 · 1 user sessions · Seen directly · /dashboard > /orders/:id/pay > /orders/:id/confirmation
      Next step: Watch one of these sessions, then generate a test plan from it if it looks right.
      Command: replaytest plan gaps-customer --session gaps-recording
      Come back with: replaytest gaps --shape form-submit-signal --since-hours 720
      Warning: This test will submit form data when it runs. Point it at a staging site or seeded test data — never at production.
  Already has a test:
    Nothing here.
  Has a test — needs review:
    Nothing here.
  Has a test — out of date:
    Nothing here.
  Might be covered by one of your own tests:
    Nothing here.
  Couldn't check:
    Nothing here.

Long multi-step flows
  Users who worked through many steps on one page: wizards, long forms.
  Before you build: Long flows tend to break in the middle. Watch one session replay before turning it into a test.
  How to read the confidence labels:
    Seen directly: From the detailed scan — we saw this happen at this exact step. (JSON value: \`exact\`)
    Strong hint: From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: \`coarse-likely\`)
    Couldn't check: The evidence needed for this check wasn't available for this row. (JSON value: \`not-assessed\`)
  We watched these users take at least 3 steps (fields filled or submits) on this one page.
  Not available — counting steps needs the detailed scan.
  We couldn't count steps for this row — it needs the detailed scan.
  No test yet (ranked — start here):
    Nothing here.
  Already has a test:
    Nothing here.
  Has a test — needs review:
    Nothing here.
  Has a test — out of date:
    Nothing here.
  Might be covered by one of your own tests:
    Nothing here.
  Couldn't check:
    1 user sessions · Couldn't check · /dashboard > /orders/:id/pay > /orders/:id/confirmation
      Next step: Fix the missing evidence first (see the note on this row).
      Command: replaytest gaps --shape deep-wizard --since-hours 720
      Come back with: replaytest gaps --shape deep-wizard --since-hours 720
      Reason: This exact row has no single-URL journey-depth evidence.

Rage clicks
  Users who clicked the same spot over and over — usually a sign something felt broken or slow.
  Before you build: Watch a replay first to judge whether this is a bug, a slow page, or nothing.
  How to read the confidence labels:
    Seen directly: From the detailed scan — we saw this happen at this exact step. (JSON value: \`exact\`)
    Strong hint: From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: \`coarse-likely\`)
    Couldn't check: The evidence needed for this check wasn't available for this row. (JSON value: \`not-assessed\`)
  We saw rage-clicking in these sessions. (Some of it is visit-wide rather than tied to this page.)
  These visits include rage clicks somewhere — not pinned to a specific spot.
  We couldn't check this row for rage clicks.
  We checked every ranked row — none matched this pattern.

How we find your own tests: we scan Playwright files for literal page addresses (page.goto / toHaveURL). Tests that build URLs dynamically won't be found.
A session can appear in more than one section, so section counts don't add up to a total.

A spot-check of your newest sessions
This is a bounded newest-first sample, separate from the traffic map above; it never refreshes from this page.
We pulled a small sample of your most recent sessions and noted practical facts — screen sizes, logins, errors. Use it to make your tests realistic and to spot trouble worth a look. Nothing here is a coverage gap, and nothing here generates a test — it's for inspection only.

No sample taken yet.
When you take one, we'll pull your most recent sessions (newest first), count each session once, and show you exactly how many we asked for vs. got and the time span they cover. A partial sample never fabricates counts — missing evidence shows as 'couldn't check', never as zero.
Take a sample now — it looks at your newest sessions without changing the map above: \`replaytest gaps --refresh-sample\``,
  gapsJson: `{
  "provenance": "exact",
  "meta": null,
  "size": {
    "total": 2,
    "shown": 2,
    "truncated": false
  },
  "gapMap": {
    "dataWindow": {
      "provenance": "exact",
      "degraded": false,
      "summary": "Includes user traffic up to an unavailable timestamp (from the last completed scan)."
    },
    "suiteInventory": {
      "state": "complete",
      "filesScanned": 0,
      "eligibleFiles": 0,
      "heuristicScope": "How we find your own tests: we scan Playwright files for literal page addresses (page.goto / toHaveURL). Tests that build URLs dynamically won't be found.",
      "summary": "We checked your existing tests (0 files scanned)."
    },
    "overlapNote": "A session can appear in more than one section, so section counts don't add up to a total.",
    "sections": [
      {
        "shape": "form-submit-signal",
        "evidence": {
          "exact": "We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)",
          "coarseLikely": "These users submitted a form at some point in their visit — we couldn't tell whether it was on this exact page.",
          "notAssessed": "We couldn't check this row for form submissions."
        },
        "consequenceNote": "A test of this journey will submit form data when it runs. Watch one session replay first, and point tests at a staging site or seeded test data — never production.",
        "noKnownLink": [
          {
            "signature": "/dashboard > /orders/:id/pay > /orders/:id/confirmation",
            "sessionCount": 1,
            "sessionCountLabel": "1 user sessions did this",
            "fidelity": "exact",
            "evidence": "We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)",
            "linkState": "no-known-link",
            "representative": {
              "distinctId": "gaps-customer",
              "sessionId": "gaps-recording",
              "status": "completed"
            },
            "action": {
              "kind": "review-and-plan",
              "label": "Watch one of these sessions, then generate a test plan from it if it looks right.",
              "command": "replaytest plan gaps-customer --session gaps-recording",
              "resumeCommand": "replaytest gaps --shape form-submit-signal --since-hours 720",
              "warning": "This test will submit form data when it runs. Point it at a staging site or seeded test data — never at production."
            },
            "suiteInventoryState": "complete",
            "rank": 1
          }
        ],
        "knownLinks": [],
        "needsReview": [],
        "superseded": [],
        "possibleSuiteMatches": [],
        "notAssessed": []
      },
      {
        "shape": "deep-wizard",
        "evidence": {
          "exact": "We watched these users take at least 3 steps (fields filled or submits) on this one page.",
          "coarseLikely": "Not available — counting steps needs the detailed scan.",
          "notAssessed": "We couldn't count steps for this row — it needs the detailed scan."
        },
        "consequenceNote": "Long flows tend to break in the middle. Watch one session replay before turning it into a test.",
        "noKnownLink": [],
        "knownLinks": [],
        "needsReview": [],
        "superseded": [],
        "possibleSuiteMatches": [],
        "notAssessed": [
          {
            "signature": "/dashboard > /orders/:id/pay > /orders/:id/confirmation",
            "sessionCount": 1,
            "sessionCountLabel": "1 user sessions did this",
            "fidelity": "not-assessed",
            "evidence": "We couldn't count steps for this row — it needs the detailed scan.",
            "linkState": "not-assessed",
            "routeLinkState": "no-known-link",
            "representative": {
              "distinctId": "gaps-customer",
              "sessionId": "gaps-recording",
              "status": "completed"
            },
            "action": {
              "kind": "resolve-unavailable-evidence",
              "label": "Fix the missing evidence first (see the note on this row).",
              "command": "replaytest gaps --shape deep-wizard --since-hours 720",
              "resumeCommand": "replaytest gaps --shape deep-wizard --since-hours 720"
            },
            "suiteInventoryState": "complete",
            "reason": "This exact row has no single-URL journey-depth evidence."
          }
        ]
      },
      {
        "shape": "rage-clicks",
        "evidence": {
          "exact": "We saw rage-clicking in these sessions. (Some of it is visit-wide rather than tied to this page.)",
          "coarseLikely": "These visits include rage clicks somewhere — not pinned to a specific spot.",
          "notAssessed": "We couldn't check this row for rage clicks."
        },
        "consequenceNote": "Watch a replay first to judge whether this is a bug, a slow page, or nothing.",
        "noKnownLink": [],
        "knownLinks": [],
        "needsReview": [],
        "superseded": [],
        "possibleSuiteMatches": [],
        "notAssessed": [],
        "emptyReason": "We checked every ranked row — none matched this pattern."
      }
    ]
  },
  "sampledObservations": {
    "state": "not-assessed",
    "message": "Take a sample now — it looks at your newest sessions without changing the map above: \`replaytest gaps --refresh-sample\`",
    "refreshCommand": "replaytest gaps --refresh-sample"
  },
  "scanMode": {
    "kind": "exact",
    "sessions": 1,
    "source": "live"
  }
}`,
  gapsStoredRefusal: 'Cannot use gaps --stored — no stored traffic scan exists in this workspace yet. --stored never contacts PostHog, so there is nothing local to read. Run `replaytest gaps` (a live scan — no --stored) to build the local coarse store; a slice seals after two scans, at least 10 minutes apart (by default), see the same number of sessions for it. `replaytest sessions` and the dashboard scan build the same store. Run `replaytest scan-status` to see what\'s already saved; "How scanning works" in the docs explains the cost model.',
  gapsStoredTable: `From your last saved scan: approximate scan of 0 sessions.
What your users do vs. what your tests cover
Each section looks at one kind of real user traffic.
Rows are ranked by how many user sessions did the same thing — Rank 1 = what users do most.
Start at the top of "No test yet": pick a row, copy its command, and turn that real journey into a test.
Traffic scanned: Includes user traffic up to Aug 10, 2026, 11:00 AM UTC (UTC: 2026-08-10T11:00:00.000Z) (from the last completed scan). History confirmed complete through Aug 10, 2026, 11:00 AM UTC (UTC: 2026-08-10T11:00:00.000Z).
Your existing tests: We checked your existing tests (0 files scanned).
Newest sessions: No spot-check sample yet — take one below.

Form submissions
  Users who submitted a form: sign-ups, checkouts, saves.
  Before you build: A test of this journey will submit form data when it runs. Watch one session replay first, and point tests at a staging site or seeded test data — never production.
  How to read the confidence labels:
    Seen directly: From the detailed scan — we saw this happen at this exact step. (JSON value: \`exact\`)
    Strong hint: From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: \`coarse-likely\`)
    Couldn't check: The evidence needed for this check wasn't available for this row. (JSON value: \`not-assessed\`)
  We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)
  These users submitted a form at some point in their visit — we couldn't tell whether it was on this exact page.
  We couldn't check this row for form submissions.
  The scan found no ranked traffic in this window.

Long multi-step flows
  Users who worked through many steps on one page: wizards, long forms.
  Before you build: Long flows tend to break in the middle. Watch one session replay before turning it into a test.
  How to read the confidence labels:
    Seen directly: From the detailed scan — we saw this happen at this exact step. (JSON value: \`exact\`)
    Strong hint: From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: \`coarse-likely\`)
    Couldn't check: The evidence needed for this check wasn't available for this row. (JSON value: \`not-assessed\`)
  We watched these users take at least 3 steps (fields filled or submits) on this one page.
  Not available — counting steps needs the detailed scan.
  We couldn't count steps for this row — it needs the detailed scan.
  The scan found no ranked traffic in this window.

Rage clicks
  Users who clicked the same spot over and over — usually a sign something felt broken or slow.
  Before you build: Watch a replay first to judge whether this is a bug, a slow page, or nothing.
  How to read the confidence labels:
    Seen directly: From the detailed scan — we saw this happen at this exact step. (JSON value: \`exact\`)
    Strong hint: From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: \`coarse-likely\`)
    Couldn't check: The evidence needed for this check wasn't available for this row. (JSON value: \`not-assessed\`)
  We saw rage-clicking in these sessions. (Some of it is visit-wide rather than tied to this page.)
  These visits include rage clicks somewhere — not pinned to a specific spot.
  We couldn't check this row for rage clicks.
  The scan found no ranked traffic in this window.

How we find your own tests: we scan Playwright files for literal page addresses (page.goto / toHaveURL). Tests that build URLs dynamically won't be found.
A session can appear in more than one section, so section counts don't add up to a total.

A spot-check of your newest sessions
This is a bounded newest-first sample, separate from the traffic map above; it never refreshes from this page.
We pulled a small sample of your most recent sessions and noted practical facts — screen sizes, logins, errors. Use it to make your tests realistic and to spot trouble worth a look. Nothing here is a coverage gap, and nothing here generates a test — it's for inspection only.

No sample taken yet.
When you take one, we'll pull your most recent sessions (newest first), count each session once, and show you exactly how many we asked for vs. got and the time span they cover. A partial sample never fabricates counts — missing evidence shows as 'couldn't check', never as zero.
Take a sample now — it looks at your newest sessions without changing the map above: \`replaytest gaps --refresh-sample\`

Stored coarse scan — a project-wide shared snapshot, recomputed locally with no PostHog contact. Covers Jul 11, 2026, 12:00 AM UTC (UTC: 2026-07-11T00:00:00.000Z) through Aug 10, 2026, 11:00 AM UTC (UTC: 2026-08-10T11:00:00.000Z). Traffic newer than the covered-through bound above has not settled yet and so is not sealable — it is absent from this map by design; re-run \`replaytest gaps\` later to seal and include it. Snapshot sealed Aug 10, 2026, 11:00 AM UTC (UTC: 2026-08-10T11:00:00.000Z).`,
  triageReport: `Verdict: selector-aged
Signature: /dashboard > /orders/:id/pay > /orders/:id/confirmation
Window: last 720h; sample 8
Heuristic priority: flow-changed (skipped when the users we could check still complete this journey) > regression-evidence > selector-aged > healthy; insufficient-evidence is returned when fresh evidence is too thin.
Spec note: tmp/cli-output-snapshot-fixtures/triage/tests/generated/snapshot-flow.spec.ts was not found; triage used the sidecar only.

E1 - Journey presence
- Coarse sessions scanned: 1 of 1
- Candidates found: 1
- Sampled: 1
- Confirmed exact matches: 1
- Skipped fetch/non-match failures: 0

E2 - Status distribution
- Baseline: the sidecar was generated from a completed journey.
- Fresh confirmed: completed 1, navigated 0, submitted 0, abandoned 0

E3 - Selector freshness
- Checked against session: triage-fresh-recording
- Pay order: getByText('Pay order') -> getByRole('link', { name: 'Pay order' }) (action-label)
- email: locator('#email') -> getByRole('textbox', { name: 'email' }) (action-label)
- Submit order: getByText('Submit order') -> getByRole('button', { name: 'Submit order' }) (action-label)

E4 - Flow variants
- No divergent entry-route variants found in the coarse scan.

Secondary findings: healthy
Persisted selector freshness evidence: tmp/cli-output-snapshot-fixtures/triage/.replaytest/state/triage-latest/snapshot-flow.json
Next: \`replaytest fix-selector snapshot-flow\` (dry run), then re-run it with \`--apply\` after review.`,
  triageJson: `{
  "verdict": "selector-aged",
  "signature": "/dashboard > /orders/:id/pay > /orders/:id/confirmation",
  "signatureSource": "sidecar",
  "window": {
    "sinceHours": 720,
    "sample": 8,
    "scanUntil": "2026-08-01T10:00:00.000Z"
  },
  "artifacts": {
    "slug": "snapshot-flow",
    "sidecarPath": "tmp/cli-output-snapshot-fixtures/triage/.replaytest/plans/snapshot-flow.plan.json",
    "specPath": "tmp/cli-output-snapshot-fixtures/triage/tests/generated/snapshot-flow.spec.ts",
    "specExists": false
  },
  "evidence": {
    "presence": {
      "coarseTotal": 1,
      "coarseScanned": 1,
      "coarseRowsSkipped": 0,
      "candidatesFound": 1,
      "sampled": 1,
      "confirmed": 1,
      "fetchFailures": 0
    },
    "statusDistribution": {
      "baseline": "completed",
      "completed": 1,
      "navigated": 0,
      "submitted": 0,
      "abandoned": 0,
      "nonCompleted": []
    },
    "selectorFreshness": {
      "checked": true,
      "matches": [
        {
          "match": "action-label",
          "sidecarIndex": 0,
          "freshIndex": 0,
          "action": "click",
          "sidecarLabel": "Pay order",
          "freshLabel": "Pay order",
          "oldLocator": "getByText('Pay order')",
          "freshLocator": "getByRole('link', { name: 'Pay order' })",
          "locatorChanged": true,
          "actionable": true
        },
        {
          "match": "action-label",
          "sidecarIndex": 1,
          "freshIndex": 1,
          "action": "fill",
          "sidecarLabel": "email",
          "freshLabel": "email",
          "oldLocator": "locator('#email')",
          "freshLocator": "getByRole('textbox', { name: 'email' })",
          "locatorChanged": true,
          "actionable": true
        },
        {
          "match": "action-label",
          "sidecarIndex": 2,
          "freshIndex": 2,
          "action": "click",
          "sidecarLabel": "Submit order",
          "freshLabel": "Submit order",
          "oldLocator": "getByText('Submit order')",
          "freshLocator": "getByRole('button', { name: 'Submit order' })",
          "locatorChanged": true,
          "actionable": true
        }
      ],
      "changed": [
        {
          "match": "action-label",
          "sidecarIndex": 0,
          "freshIndex": 0,
          "action": "click",
          "sidecarLabel": "Pay order",
          "freshLabel": "Pay order",
          "oldLocator": "getByText('Pay order')",
          "freshLocator": "getByRole('link', { name: 'Pay order' })",
          "locatorChanged": true,
          "actionable": true
        },
        {
          "match": "action-label",
          "sidecarIndex": 1,
          "freshIndex": 1,
          "action": "fill",
          "sidecarLabel": "email",
          "freshLabel": "email",
          "oldLocator": "locator('#email')",
          "freshLocator": "getByRole('textbox', { name: 'email' })",
          "locatorChanged": true,
          "actionable": true
        },
        {
          "match": "action-label",
          "sidecarIndex": 2,
          "freshIndex": 2,
          "action": "click",
          "sidecarLabel": "Submit order",
          "freshLabel": "Submit order",
          "oldLocator": "getByText('Submit order')",
          "freshLocator": "getByRole('button', { name: 'Submit order' })",
          "locatorChanged": true,
          "actionable": true
        }
      ],
      "unmatchedSidecar": [],
      "unmatchedFresh": [],
      "sessionId": "triage-fresh-recording",
      "distinctId": "triage-fresh-customer"
    },
    "flowVariants": []
  },
  "secondaryFindings": [
    "healthy"
  ]
}`,
  triageMissingSidecar: 'Cannot triage "missing-flow": no sidecar found at tmp/cli-output-snapshot-fixtures/triage/.replaytest/plans/missing-flow.plan.json. If this journey should exist, create it with `replaytest plan <distinctId>`; if the slug is wrong, check .replaytest/plans/ for the correct one.',
  triageMalformedMaxAgeStderr: 'Unrecognized --max-age value "not-a-duration" (expected seconds or <h>h<m>m<s>s); using the default 3600s.\n',
  triageProposal: `Verdict: flow-changed
Signature: /dashboard > /orders/:id/pay > /orders/:id/confirmation
Window: last 720h; sample 8
Heuristic priority: flow-changed (skipped when the users we could check still complete this journey) > regression-evidence > selector-aged > healthy; insufficient-evidence is returned when fresh evidence is too thin.
Spec note: tmp/cli-output-snapshot-fixtures/triage-proposal/tests/generated/proposal-flow.spec.ts was not found; triage used the sidecar only.

E1 - Journey presence
- Coarse sessions scanned: 1 of 1
- Candidates found: 3
- Sampled: 3
- Confirmed exact matches: 1
- Skipped fetch/non-match failures: 2

E2 - Status distribution
- Baseline: the sidecar was generated from a completed journey.
- Fresh confirmed: completed 0, navigated 1, submitted 0, abandoned 0

E3 - Selector freshness
- Not checked: no fresh completed instance to compare selectors against (all confirmed matches were non-completed)

E4 - Flow variants
- 2 session(s): /dashboard > /orders/:id/review > /orders/:id/confirmation

Proposal
- ⚠ This proposal REPLACES the recording behind this test.
- Final destination: was /orders/1001/confirmation → now /orders/5005/confirmation.
- Source recording: was session triage-original-recording (distinct ID triage-original-customer; signature /dashboard > /orders/:id/pay > /orders/:id/confirmation) → now session proposal-fresh-recording (distinct ID proposal-fresh-customer; signature /dashboard > /orders/:id/review > /orders/:id/confirmation).
- ⚠ Representative: /dashboard > /orders/:id/review > /orders/:id/confirmation — UNRELATED to the original signature beyond the entry page (no kin variant found in fresh traffic). Verify it is truly the successor flow before accepting; if the original flow still exists, drive or wait for fresh traffic and re-run triage.
- Wrote tmp/cli-output-snapshot-fixtures/triage-proposal/.replaytest/plans/proposal-flow.proposed.plan.json
- Wrote tmp/cli-output-snapshot-fixtures/triage-proposal/.replaytest/plans/proposal-flow.proposed.md
- Wrote tmp/cli-output-snapshot-fixtures/triage-proposal/.replaytest/plans/proposal-flow.proposed.diff.md

Plan diff:
# Plan diff

⚠ Journey changed — different flow: /dashboard > /orders/:id/pay > /orders/:id/confirmation → /dashboard > /orders/:id/review > /orders/:id/confirmation
Changed: 3 assertions, 5 steps, 3 plan facts, 5 caveats

## Assertions

- Added: page-shows-text "Order confirmed" (enabled: true)
- Added: no-console-errors (enabled: true)
- Changed: final-url
  - value: /orders/1001/confirmation → /orders/5005/confirmation
  - pattern: (none) → ^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation$

## Steps

- Removed: click "Pay order" (getByText('Pay order'))
- Removed: fill "email" (locator('#email'))
- Removed: click "Submit order" (getByText('Submit order'))
- Added: click "Review order" (getByRole('link', { name: 'Review order' }))
- Added: click "Confirm order" (getByRole('button', { name: 'Confirm order' }))

## Plan facts

- title: Order confirmation → Confirmation
- dataRequirements added [0]: path=/orders/5005/review, canonicalPath=/orders/:id/review
- dataRequirements added [1]: path=/orders/5005/confirmation, canonicalPath=/orders/:id/confirmation, createdByJourney=true

## Caveats

- caveat added [0]: Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- caveat added [1]: This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- caveat added [2]: The asserted page text comes from one session — verify it is not user-specific before relying on it.
- caveat added [3]: This proposal replaces the journey with a flow UNRELATED to the original signature (only the entry page is shared). That usually means fresh traffic carries no successor of the original flow yet — if the original flow still exists, drive or wait for fresh traffic and re-run triage rather than accepting this replacement.
- caveat added [4]: This plan is backed by a different recorded session. Journey signature changed from /dashboard > /orders/:id/pay > /orders/:id/confirmation to /dashboard > /orders/:id/review > /orders/:id/confirmation; final destination changed from /orders/1001/confirmation to /orders/5005/confirmation.

## Bookkeeping

- Source: session triage-original-recording → proposal-fresh-recording (also changed: distinctId, generatedAt)
Persisted selector freshness evidence: tmp/cli-output-snapshot-fixtures/triage-proposal/.replaytest/state/triage-latest/proposal-flow.json
No safely replaceable selector patch was found because selector freshness could not be checked against a fresh completed journey.`,
  regenerateProposal: `Regenerated proposal for regenerate-flow.
Source: Tier A — same journey, fresh session.
Fresh candidate: session regenerate-fresh-recording (signature /dashboard > /orders/:id/pay > /orders/:id/confirmation).
Wrote .replaytest/plans/regenerate-flow.proposed.plan.json
Wrote .replaytest/plans/regenerate-flow.proposed.md
Wrote .replaytest/plans/regenerate-flow.proposed.diff.md
Plan diff: replaytest diff regenerate-flow
Spec delta: replaytest never merges tests/generated/regenerate-flow.spec.ts. Apply the reviewed delta yourself, then inspect \`git diff -- tests/generated/regenerate-flow.spec.ts\`.
Next: review \`replaytest diff regenerate-flow\`, apply the spec delta yourself, verify, then \`replaytest accept regenerate-flow --force\`.`,
} as const;

interface FixtureWorkspace {
  root: string;
  plansDir: string;
  generatedTestsDir: string;
  triageEvidenceDir: string;
  healLatestPath: string;
}

function workspace(name: string): FixtureWorkspace {
  const root = path.join(FIXTURE_ROOT, name);
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const triageEvidenceDir = path.join(root, '.replaytest', 'state', 'triage-latest');
  const healLatestPath = path.join(root, '.replaytest', 'state', 'heal-latest.json');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  return { root, plansDir, generatedTestsDir, triageEvidenceDir, healLatestPath };
}

function orderSteps(
  orderId: string,
  inputTarget: NeutralTarget = { tag: 'input', id: 'email', attributes: { type: 'email' } },
): NeutralStep[] {
  const dashboard = 'http://app.test/dashboard';
  const pay = `http://app.test/orders/${orderId}/pay`;
  const confirmation = `http://app.test/orders/${orderId}/confirmation`;
  return [
    { kind: 'navigation', url: dashboard, at: '2026-08-01T09:00:00.000Z' },
    { kind: 'click', url: dashboard, at: '2026-08-01T09:00:01.000Z', target: { tag: 'a', text: 'Pay order' } },
    { kind: 'navigation', url: pay, at: '2026-08-01T09:00:02.000Z' },
    { kind: 'input', url: pay, at: '2026-08-01T09:00:03.000Z', target: inputTarget },
    { kind: 'submit', url: pay, at: '2026-08-01T09:00:04.000Z', target: { tag: 'button', text: 'Submit order' } },
    { kind: 'navigation', url: confirmation, at: '2026-08-01T09:00:05.000Z', pageHeading: 'Order confirmed' },
  ];
}

function session(id: string, distinctId: string, steps: NeutralStep[]): NeutralSession {
  return {
    id,
    distinctId,
    startedAt: steps[0]?.at ?? '2026-08-01T09:00:00.000Z',
    endedAt: steps.at(-1)?.at ?? '2026-08-01T09:00:00.000Z',
    finalUrl: steps.at(-1)?.url ?? 'http://app.test/',
    steps,
  };
}

function configuredStatus() {
  return { projectId: 'snapshot-project', hasApiKey: true, host: 'https://us.posthog.com' };
}

function baseConfigDeps() {
  return {
    getProviderConfigStatus: configuredStatus,
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: {} }),
  };
}

function emptySessionsCoverage() {
  return {
    planIndex: [],
    specSlugs: [],
    suiteFiles: [],
    suiteScan: {
      state: 'complete' as const,
      filesScanned: 0,
      capped: false,
      maxFiles: 500,
      maxFileBytes: 512 * 1024,
      note: 'Suite-match heuristic: a source scan only reports a possible match; it never proves behavioral coverage.',
    },
  };
}

function writeStoredSessionsSnapshot(fixture: FixtureWorkspace): void {
  const cacheDir = path.join(fixture.root, '.replaytest', 'cache');
  const store = new DashboardLocalStore(cacheDir);
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'snapshot-project' },
    '["sessions","--json"]|wizardStepParams=[]|limit=undefined',
    {
      provenance: 'exact',
      meta: null,
      sessions: [{
        rank: 1,
        signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
        sessionCount: 1,
        provenance: 'exact',
        status: 'completed',
        completionEvidence: 'submit-then-nav',
        representativeDistinctId: 'stored-customer',
        representativeSessionId: 'stored-recording',
        representativeStartedAt: '2026-08-01T09:00:00.000Z',
        representativeEndedAt: '2026-08-01T09:00:05.000Z',
        examplePaths: ['/dashboard > /orders/4004/pay > /orders/4004/confirmation'],
        planned: false,
        tested: false,
      }],
      suiteScan: emptySessionsCoverage().suiteScan,
      cache: { servedFromCache: false, scannedAt: '2026-08-10T11:00:00.000Z', ttlRemainingMs: null },
    },
  );
}

function writeSnapshotPlan(fixture: FixtureWorkspace): void {
  fs.writeFileSync(path.join(fixture.plansDir, 'snapshot-flow.plan.json'), JSON.stringify({
    version: 1,
    title: 'Snapshot flow',
    source: {
      sessionId: 'sessions-recording',
      distinctId: 'sessions-customer',
      journeyIndex: 0,
      generatedAt: '2026-08-01T09:00:05.000Z',
      tool: 'snapshot-test',
      signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
    },
    start: '/dashboard',
    steps: [],
    assertions: [],
  }), 'utf8');
}

function variantOrderSteps(orderId: string): NeutralStep[] {
  const dashboard = 'http://app.test/dashboard';
  const review = `http://app.test/orders/${orderId}/review`;
  const confirmation = `http://app.test/orders/${orderId}/confirmation`;
  return [
    { kind: 'navigation', url: dashboard, at: '2026-08-01T09:00:00.000Z' },
    { kind: 'click', url: dashboard, at: '2026-08-01T09:00:01.000Z', target: { tag: 'a', text: 'Review order' } },
    { kind: 'navigation', url: review, at: '2026-08-01T09:00:02.000Z' },
    { kind: 'submit', url: review, at: '2026-08-01T09:00:03.000Z', target: { tag: 'button', text: 'Confirm order' } },
    { kind: 'navigation', url: confirmation, at: '2026-08-01T09:00:04.000Z', pageHeading: 'Order confirmed' },
  ];
}

function assertSnapshot(name: keyof typeof SNAPSHOTS, output: string): void {
  // The OS-temp parent is intentionally nondeterministic. The established
  // snapshot prefix is its stable test-only stand-in; all text after that
  // root remains byte-pinned.
  const normalized = output.replaceAll(FIXTURE_ROOT, 'tmp/cli-output-snapshot-fixtures');
  if (process.env[REFREEZE_CLI_OUTPUT_SNAPSHOTS] === '1') {
    refreezeSnapshot(name, normalized);
    return;
  }
  assert.strictEqual(normalized, SNAPSHOTS[name], name);
}

/** Refreshes one inline snapshot only under the explicit test-local switch above. */
function refreezeSnapshot(name: keyof typeof SNAPSHOTS, snapshot: string): void {
  if (process.env[REFREEZE_CLI_OUTPUT_SNAPSHOTS] !== '1') return;
  const testPath = fileURLToPath(import.meta.url);
  const source = fs.readFileSync(testPath, 'utf8');
  const propertyPrefix = `  ${name}: `;
  const start = source.indexOf(propertyPrefix);
  assert.notEqual(start, -1, `missing inline snapshot property: ${name}`);
  const delimiterIndex = start + propertyPrefix.length;
  const delimiter = source[delimiterIndex];
  assert.ok(delimiter === '`' || delimiter === "'", `unsupported inline snapshot delimiter: ${name}`);
  let valueEnd = delimiterIndex + 1;
  while (valueEnd < source.length) {
    if (source[valueEnd] === delimiter) {
      let precedingBackslashes = 0;
      for (let index = valueEnd - 1; source[index] === '\\'; index -= 1) precedingBackslashes += 1;
      if (precedingBackslashes % 2 === 0) break;
    }
    valueEnd += 1;
  }
  assert.notEqual(valueEnd, source.length, `missing inline snapshot terminator: ${name}`);
  const serialized = snapshot
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', delimiter === "'" ? '\\r' : '\r')
    .replaceAll('\n', delimiter === "'" ? '\\n' : '\n')
    .replaceAll(delimiter, `\\${delimiter}`)
    .replaceAll('${', delimiter === '`' ? '\\${' : '${');
  const updated = `${source.slice(0, delimiterIndex + 1)}${serialized}${source.slice(valueEnd)}`;
  if (updated !== source) fs.writeFileSync(testPath, updated, 'utf8');
}

function plannedSessionsJsonSnapshot(): string {
  const expected = JSON.parse(SNAPSHOTS.sessionsJson) as {
    journeys: Array<Record<string, unknown>>;
    suiteScan: Record<string, unknown>;
    stalePlanSignatures?: unknown;
  };
  const needsReview = {
    kind: 'older-url-semantics',
    note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
    replanCommand: 'replaytest plan sessions-customer --session sessions-recording',
  };
  const journey = expected.journeys[0];
  assert.ok(journey);
  expected.journeys[0] = {
    rank: journey.rank,
    signature: journey.signature,
    sessionCount: journey.sessionCount,
    provenance: journey.provenance,
    status: journey.status,
    completionEvidence: journey.completionEvidence,
    representativeDistinctId: journey.representativeDistinctId,
    representativeSessionId: journey.representativeSessionId,
    representativeStartedAt: journey.representativeStartedAt,
    representativeEndedAt: journey.representativeEndedAt,
    examplePaths: journey.examplePaths,
    planned: true,
    planSlug: 'snapshot-flow',
    tested: false,
    needsReview,
    lifecycle: 'planned',
    evidenceBasis: 'plan sidecar',
    coverage: {
      planned: true,
      planSlug: 'snapshot-flow',
      tested: false,
      lifecycle: 'planned',
      evidenceBasis: 'plan sidecar',
      needsReview,
    },
    replay: journey.replay,
  };
  expected.suiteScan = {
    state: 'complete',
    filesScanned: 0,
    capped: false,
    skippedStandardDirs: false,
    maxFiles: 500,
    maxFileBytes: 524288,
    note: 'A best-effort guess that one of your existing hand-written tests may already cover it — a guess, not a guarantee.',
  };
  expected.stalePlanSignatures = {
    plans: [{
      slug: 'snapshot-flow',
      kind: 'older-url-semantics',
      note: needsReview.note,
      distinctId: 'sessions-customer',
      sessionId: 'sessions-recording',
      replanCommand: needsReview.replanCommand,
    }],
    note: 'Plans built under older signature rules may read as uncovered — re-run plan for them.',
  };
  return JSON.stringify(expected, null, 2);
}

async function withExitCodeReset<T>(run: () => T | Promise<T>): Promise<T> {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    return await run();
  } finally {
    process.exitCode = previous;
  }
}

test('sessions output snapshots cover table, JSON, and refusal renderings', async () => {
  const fixture = workspace('sessions');
  const recorded = session('sessions-recording', 'sessions-customer', orderSteps('1001'));
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-01T10:00:00.000Z' }),
    fetchAllSessions: () => [recorded],
  };

  const table: string[] = [];
  const tableWarnings: string[] = [];
  await withExitCodeReset(() => {
    runSessions([], {
      ...baseConfigDeps(),
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: path.join(fixture.root, 'tests'),
      fetchers,
      warn: (line) => tableWarnings.push(line),
      log: (line) => table.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(table.length, 1);
  assert.deepEqual(tableWarnings, []);
  assertSnapshot('sessionsTable', table[0] ?? '');

  writeSnapshotPlan(fixture);
  const json: string[] = [];
  const jsonWarnings: string[] = [];
  await withExitCodeReset(() => {
    runSessions(['--json'], {
      ...baseConfigDeps(),
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: path.join(fixture.root, 'tests'),
      fetchers,
      warn: (line) => jsonWarnings.push(line),
      log: (line) => json.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(json.length, 1);
  assert.deepEqual(jsonWarnings, []);
  assert.strictEqual(
    (json[0] ?? '').replaceAll(FIXTURE_ROOT, 'tmp/cli-output-snapshot-fixtures'),
    plannedSessionsJsonSnapshot(),
    'sessionsJson lifecycle path is an additive snapshot',
  );

  writeStoredSessionsSnapshot(fixture);
  const storedTable: string[] = [];
  const storedTableWarnings: string[] = [];
  await withExitCodeReset(() => {
    runSessions(['--stored'], {
      ...baseConfigDeps(),
      dashboardCacheDir: path.join(fixture.root, '.replaytest', 'cache'),
      localCoverageInputs: emptySessionsCoverage,
      warn: (line) => storedTableWarnings.push(line),
      log: (line) => storedTable.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(storedTable.length, 1);
  assert.deepEqual(storedTableWarnings, []);
  assertSnapshot('sessionsStoredTable', storedTable[0] ?? '');

  const storedJson: string[] = [];
  const storedJsonWarnings: string[] = [];
  await withExitCodeReset(() => {
    runSessions(['--stored', '--json'], {
      ...baseConfigDeps(),
      dashboardCacheDir: path.join(fixture.root, '.replaytest', 'cache'),
      localCoverageInputs: emptySessionsCoverage,
      warn: (line) => storedJsonWarnings.push(line),
      log: (line) => storedJson.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(storedJson.length, 1);
  assert.deepEqual(storedJsonWarnings, []);
  assertSnapshot('sessionsStoredJson', storedJson[0] ?? '');

  const shapeTable: string[] = [];
  const shapeWarnings: string[] = [];
  const shapePlansDir = path.join(fixture.root, 'shape-plans');
  fs.mkdirSync(shapePlansDir, { recursive: true });
  await withExitCodeReset(() => {
    runSessions(['--shape', 'form-submit-signal'], {
      ...baseConfigDeps(),
      plansDir: shapePlansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: path.join(fixture.root, 'tests'),
      fetchers,
      localCoverageInputs: emptySessionsCoverage,
      warn: (line) => shapeWarnings.push(line),
      log: (line) => shapeTable.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(shapeTable.length, 1);
  assert.deepEqual(shapeWarnings, []);
  assertSnapshot('sessionsShapeTable', shapeTable[0] ?? '');

  const unavailableCoverageOutput: string[] = [];
  const unavailableCoverageWarnings: string[] = [];
  await withExitCodeReset(() => {
    runSessions(['--json'], {
      ...baseConfigDeps(),
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: path.join(fixture.root, 'tests'),
      fetchers,
      localCoverageInputs: () => {
        throw new Error('snapshot coverage fixture unavailable');
      },
      warn: (line) => unavailableCoverageWarnings.push(line),
      log: (line) => unavailableCoverageOutput.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(unavailableCoverageOutput.length, 1);
  assert.deepEqual(unavailableCoverageWarnings, [
    'Suite scan unavailable — suite matches are unknown: snapshot coverage fixture unavailable',
  ]);

  const refusal: string[] = [];
  const refusalWarnings: string[] = [];
  await withExitCodeReset(() => {
    runSessions(['--replay-availability'], {
      ...baseConfigDeps(),
      warn: (line) => refusalWarnings.push(line),
      log: (line) => refusal.push(line),
    });
    assert.equal(process.exitCode, 1);
  });
  assert.equal(refusal.length, 1);
  assert.deepEqual(refusalWarnings, []);
  assertSnapshot('sessionsRefusal', refusal[0] ?? '');
});

/**
 * The anti-vacuity closure for the origin-attribution work: this compares a
 * post-change single-property scan against the snapshot strings COMMITTED
 * before the origin field existed, never against freshly generated output. If
 * the field ever serializes as `[]`/`null` on a single-property scan, or the
 * `sites` column ever renders below its threshold, this is what goes red.
 */
test('origin attribution case 1 (byte-parity): a single-property scan is byte-identical to the pre-change sessions table and JSON, with no sites column and no origin key', async () => {
  const fixture = workspace('origin-single-property');
  const recorded = session('sessions-recording', 'sessions-customer', orderSteps('1001'));
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-01T10:00:00.000Z' }),
    fetchAllSessions: () => [recorded],
  };
  const shared = {
    ...baseConfigDeps(),
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    suiteScanRoot: path.join(fixture.root, 'tests'),
    fetchers,
  };

  const table: string[] = [];
  await withExitCodeReset(() => {
    runSessions([], { ...shared, log: (line) => table.push(line) });
    assert.equal(process.exitCode, undefined);
  });
  assertSnapshot('sessionsTable', table[0] ?? '');
  assert.ok(!(table[0] ?? '').includes('sites'), 'no sites column below the mixed-origin threshold');

  const json: string[] = [];
  await withExitCodeReset(() => {
    runSessions(['--json'], { ...shared, localCoverageInputs: emptySessionsCoverage, log: (line) => json.push(line) });
    assert.equal(process.exitCode, undefined);
  });
  assertSnapshot('sessionsJson', json[0] ?? '');
  assert.ok(!(json[0] ?? '').includes('witnessedOrigins'), 'the origin key is absent, not empty');
});

test('gaps output snapshots cover table, JSON, and stored refusal renderings', async () => {
  const fixture = workspace('gaps');
  const recorded = session('gaps-recording', 'gaps-customer', orderSteps('2002'));
  const deps = {
    ...baseConfigDeps(),
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-01T10:00:00.000Z' }),
      fetchAllSessions: () => [recorded],
    },
    localInputs: async () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
    getProjectFingerprint: () => 'snapshot-project-fingerprint',
    readSampledRegister: () => undefined,
    now: () => FIXED_NOW,
  };

  const table: string[] = [];
  await withExitCodeReset(async () => {
    await runGaps([], { ...deps, log: (line) => table.push(line) });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(table.length, 1);
  assertSnapshot('gapsTable', table[0] ?? '');

  const json: string[] = [];
  await withExitCodeReset(async () => {
    await runGaps(['--json'], { ...deps, log: (line) => json.push(line) });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(json.length, 1);
  assertSnapshot('gapsJson', json[0] ?? '');

  const refusal: string[] = [];
  await withExitCodeReset(async () => {
    await runGaps(['--stored'], {
      ...deps,
      readStoredCoarseStore: (() => ({ kind: 'missing', reason: 'absent' })) as never,
      log: (line) => refusal.push(line),
    });
    assert.equal(process.exitCode, 1);
  });
  assert.equal(refusal.length, 1);
  assertSnapshot('gapsStoredRefusal', refusal[0] ?? '');

  const storedTable: string[] = [];
  await withExitCodeReset(async () => {
    await runGaps(['--stored'], {
      ...deps,
      coarseStoreDir: path.join(fixture.root, '.replaytest', 'coarse-store'),
      readStoredCoarseStore: (() => ({
        kind: 'served',
        settled: true,
        sessions: [],
        coverage: {
          coveredFrom: '2026-07-11T00:00:00.000Z',
          coveredTo: '2026-08-10T11:00:00.000Z',
          sealedThrough: '2026-08-10T11:00:00.000Z',
          snapshotSealedAt: '2026-08-10T11:00:00.000Z',
          pendingSlices: 0,
          holes: [],
          storedRowsSkipped: 0,
        },
      })) as never,
      log: (line) => storedTable.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(storedTable.length, 1);
  assertSnapshot('gapsStoredTable', storedTable[0] ?? '');
});

function triageSidecar(): Sidecar {
  return {
    version: 1,
    title: 'Order confirmation',
    source: {
      distinctId: 'triage-original-customer',
      sessionId: 'triage-original-recording',
      journeyIndex: 0,
      signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
      generatedAt: '2026-08-01T09:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/dashboard',
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByText('Pay order')" },
      { action: 'fill', label: 'email', locator: "locator('#email')" },
      { action: 'click', label: 'Submit order', locator: "getByText('Submit order')" },
    ],
    assertions: [{ type: 'final-url', value: '/orders/1001/confirmation', enabled: true }],
  };
}

function triageDeps(fixture: FixtureWorkspace) {
  const fresh = session(
    'triage-fresh-recording',
    'triage-fresh-customer',
    orderSteps('3003', { tag: 'input', labelText: 'email', attributes: { type: 'email' } }),
  );
  const coarse = {
    sessionId: fresh.id,
    distinctId: fresh.distinctId,
    firstTs: fresh.startedAt,
    lastTs: fresh.endedAt,
    navPath: fresh.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: fresh.steps.filter((step) => step.kind === 'submit').length,
    eventCount: fresh.steps.length,
  };
  return {
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    triageEvidenceDir: fixture.triageEvidenceDir,
    healLatestPath: fixture.healLatestPath,
    now: () => new Date(FIXED_NOW),
    getProviderConfigStatus: configuredStatus,
    fetchCoarseSessions: () => ({
      sessions: [coarse],
      meta: {
        scanUntil: '2026-08-01T10:00:00.000Z',
        sessionsSeen: 1,
        totalSessionsAtScanStart: 1,
        capped: false,
        windowHours: 720,
        rowsSkipped: 0,
      },
    }),
    fetchNeutralSessionsLight: (_distinctId: string, sessionId?: string) => sessionId === fresh.id ? [fresh] : [],
    fetchNeutralSessionsWithDomEnrichment: async (_distinctId: string, sessionId?: string) => sessionId === fresh.id ? [fresh] : [],
  };
}

test('triage output snapshots cover report, JSON, and missing-sidecar renderings', async () => {
  const fixture = workspace('triage');
  const slug = 'snapshot-flow';
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.plan.json`), `${JSON.stringify(triageSidecar(), null, 2)}\n`, 'utf8');
  const deps = triageDeps(fixture);

  const report: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([slug], { ...deps, log: (line) => report.push(line) });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(report.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.triageEvidenceDir, `${slug}.json`)), true);
  assertSnapshot('triageReport', report[0] ?? '');

  const json: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([slug, '--json'], { ...deps, log: (line) => json.push(line) });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(json.length, 1);
  assertSnapshot('triageJson', json[0] ?? '');

  const refusal: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage(['missing-flow'], { ...deps, log: (line) => refusal.push(line) });
    assert.equal(process.exitCode, 1);
  });
  assert.equal(refusal.length, 1);
  assertSnapshot('triageMissingSidecar', refusal[0] ?? '');

  const malformedMaxAgeLogs: string[] = [];
  const stderr = await captureProcessStderr(async () => {
    await withExitCodeReset(async () => {
      await runTriage([slug, '--reuse-evidence', '--max-age', 'not-a-duration'], {
        ...deps,
        log: (line) => malformedMaxAgeLogs.push(line),
      });
      assert.equal(process.exitCode, undefined);
    });
  });
  assert.equal(malformedMaxAgeLogs.length, 1);
  assertSnapshot('triageMalformedMaxAgeStderr', stderr);
});

test('triage proposal output snapshot names its exact produced-file set', async () => {
  const fixture = workspace('triage-proposal');
  const slug = 'proposal-flow';
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.plan.json`), `${JSON.stringify(triageSidecar(), null, 2)}\n`, 'utf8');
  const matching = session(
    'proposal-matching-recording',
    'proposal-matching-customer',
    orderSteps('4004').filter((step) => step.kind !== 'submit'),
  );
  const matchingUnconfirmed = session('proposal-matching-unconfirmed', 'proposal-matching-unconfirmed-customer', orderSteps('4005'));
  const matchingSecondUnconfirmed = session('proposal-matching-second-unconfirmed', 'proposal-matching-second-unconfirmed-customer', orderSteps('4006'));
  const fresh = session('proposal-fresh-recording', 'proposal-fresh-customer', variantOrderSteps('5005'));
  const olderVariant = session(
    'proposal-older-variant',
    'proposal-older-variant-customer',
    variantOrderSteps('5004').map((step) => ({ ...step, at: new Date(Date.parse(step.at) - 1000).toISOString() })),
  );
  const coarse = {
    sessionId: fresh.id,
    distinctId: fresh.distinctId,
    firstTs: fresh.startedAt,
    lastTs: fresh.endedAt,
    navPath: fresh.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: fresh.steps.filter((step) => step.kind === 'submit').length,
    eventCount: fresh.steps.length,
  };
  const output: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([slug, '--propose', '--force'], {
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      triageEvidenceDir: fixture.triageEvidenceDir,
      healLatestPath: fixture.healLatestPath,
      now: () => new Date(FIXED_NOW),
      getProviderConfigStatus: configuredStatus,
      fetchCoarseSessions: () => ({
        sessions: [
          coarse,
          ...[matching, matchingUnconfirmed, matchingSecondUnconfirmed, olderVariant].map((candidate) => ({
            sessionId: candidate.id,
            distinctId: candidate.distinctId,
            firstTs: candidate.startedAt,
            lastTs: candidate.endedAt,
            navPath: candidate.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
            submitCount: candidate.steps.filter((step) => step.kind === 'submit').length,
            eventCount: candidate.steps.length,
          })),
        ],
        meta: {
          scanUntil: '2026-08-01T10:00:00.000Z',
          sessionsSeen: 1,
          totalSessionsAtScanStart: 1,
          capped: false,
          windowHours: 720,
          rowsSkipped: 0,
        },
      }),
      fetchNeutralSessionsLight: (_distinctId: string, sessionId?: string) => {
        if (sessionId === matching.id) return [matching];
        if (sessionId === matchingUnconfirmed.id || sessionId === matchingSecondUnconfirmed.id) throw new Error('not confirmed in this fixture');
        return [];
      },
      fetchNeutralSessionsWithDomEnrichment: async (_distinctId: string, sessionId?: string) => {
        if (sessionId === matching.id) return [matching];
        return sessionId === fresh.id ? [fresh] : [];
      },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(output.length, 1);
  assertSnapshot('triageProposal', output[0] ?? '');
  assert.deepEqual(
    [
      ...fs.readdirSync(fixture.plansDir).filter((name) => name !== `${slug}.plan.json`).map((name) => `plans/${name}`),
      ...fs.readdirSync(fixture.triageEvidenceDir).map((name) => `state/${name}`),
    ].sort(),
    [
      `plans/${slug}.proposed.diff.md`,
      `plans/${slug}.proposed.md`,
      `plans/${slug}.proposed.plan.json`,
      `state/${slug}.json`,
      `state/${slug}.report-cache.json`,
    ],
  );
});

test('regenerate proposal output snapshot names the Tier A source, proposal slot, diff pointer, and agent-owned spec delta', async () => {
  const fixture = workspace('regenerate');
  const slug = 'regenerate-flow';
  const live = {
    ...triageSidecar(),
    source: {
      ...triageSidecar().source,
      origin: 'http://app.test',
      signatureSemanticsVersion: 1,
      wizardStepParamNames: [],
    },
  };
  fs.writeFileSync(path.join(fixture.plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  const fresh = session('regenerate-fresh-recording', 'regenerate-fresh-customer', orderSteps('6006'));
  const coarse = {
    sessionId: fresh.id,
    distinctId: fresh.distinctId,
    firstTs: fresh.startedAt,
    lastTs: fresh.endedAt,
    navPath: fresh.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: fresh.steps.filter((step) => step.kind === 'submit').length,
    eventCount: fresh.steps.length,
  };
  const output: string[] = [];
  await withExitCodeReset(async () => {
    await runRegenerate([slug], {
      ...baseConfigDeps(),
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      fetchCoarseSessions: () => ({
        sessions: [coarse],
        meta: {
          scanUntil: '2026-08-01T10:00:00.000Z',
          sessionsSeen: 1,
          totalSessionsAtScanStart: 1,
          capped: false,
          windowHours: 720,
          rowsSkipped: 0,
        },
      }),
      fetchNeutralSessionsLight: (_distinctId: string, sessionId?: string) => sessionId === fresh.id ? [fresh] : [],
      fetchNeutralSessionsWithDomEnrichment: async (_distinctId: string, sessionId?: string) => sessionId === fresh.id ? [fresh] : [],
      progress: () => {},
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.equal(output.length, 1);
  assertSnapshot('regenerateProposal', output[0] ?? '');
  assert.deepEqual(
    fs.readdirSync(fixture.plansDir).sort(),
    [`${slug}.plan.json`, `${slug}.proposed.diff.md`, `${slug}.proposed.md`, `${slug}.proposed.plan.json`],
  );
});
