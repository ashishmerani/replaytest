import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMissingPreflightSidecarError, buildVerbHelpText, buildUsageError, runPreflight } from '../../cli.js';
import type { LocatorLivenessBrowser, LocatorLivenessLocator, LocatorLivenessPage } from '../../locator-liveness.js';
import { hashSpecContent } from '../../heal-run-hashes.js';
import { hashPlanSidecarContent, PLAN_HASH_DOMAIN, type PlanDriftState, type SpecEmittedHashEntry } from '../../spec-emitted-hashes.js';
import { survivingScaffoldForceAdvice } from '../../hand-finished.test-support.js';
import type { Sidecar } from '../../sidecar.js';

test('runPreflight: --help returns before the required <slug> is validated or a local sidecar is read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runPreflight(['--help'], {
      pathExists: () => {
        throw new Error('pathExists must not be called for --help');
      },
      readFile: () => {
        throw new Error('readFile must not be called for --help');
      },
      launchBrowser: async () => {
        throw new Error('launchBrowser must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('preflight')]);
    assert.equal(process.exitCode, undefined);
    assert.notDeepEqual(output, [buildUsageError('preflight')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPreflight: reads only the local sidecar, maps an action URL to TARGET_APP_URL, and emits the same liveness row in JSON', async () => {
  const locator: LocatorLivenessLocator = {
    count: async () => 2,
    nth: () => locator,
  };
  const noPasswordLocator: LocatorLivenessLocator = {
    count: async () => 0,
    nth: () => noPasswordLocator,
  };
  let openedUrl: string | undefined;
  const page: LocatorLivenessPage = {
    goto: async (url) => {
      openedUrl = url;
      return { status: () => 200 };
    },
    url: () => openedUrl ?? 'http://live.example:8000/settings',
    getByTestId: () => locator,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByText: () => locator,
    locator: (selector) => selector === 'input[type=password]' ? noPasswordLocator : locator,
  };
  let closed = false;
  const browser: LocatorLivenessBrowser = {
    newPage: async () => page,
    close: async () => {
      closed = true;
    },
  };
  const output: string[] = [];
  const progress: string[] = [];
  const sidecar = JSON.stringify({
    version: 1,
    title: 'Checkout',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      generatedAt: '2026-07-22T00:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/',
    steps: [{ action: 'click', label: 'Save', locator: "getByTestId('save')", url: 'https://recorded.example/settings' }],
    assertions: [],
  });

  await runPreflight(['checkout', '--json'], {
    plansDir: '/fixture/plans',
    pathExists: (filename) => filename === '/fixture/plans/checkout.plan.json',
    readFile: () => sidecar,
    targetAppUrl: 'http://live.example:8000',
    launchBrowser: async () => browser,
    progress: (line) => progress.push(line),
    log: (line) => output.push(line),
  });

  assert.equal(openedUrl, 'http://live.example:8000/settings');
  assert.equal(closed, true);
  assert.deepEqual(progress, ['Preflight: checking 1 recorded selector(s) against the target app.']);
  assert.deepEqual(JSON.parse(output[0] ?? ''), {
    slug: 'checkout',
    verdict: 'passed',
    baseUrl: 'http://live.example:8000',
    baseUrlSource: 'option',
    targetAppUrl: 'http://live.example:8000',
    summary: { totalSelectors: 1, resolves: 1, dead: 0, gatedUnreachable: 0, couldntCheck: 0 },
    steps: [{
      recordedAction: 1,
      action: 'click',
      label: 'Save',
      locator: "getByTestId('save')",
      recordedUrl: 'https://recorded.example/settings',
      liveUrl: 'http://live.example:8000/settings',
      lane: 'resolves',
      count: 2,
      reason: '2 matching elements on a page that returned HTTP 200 (more than one resolves).',
    }],
    // This fixture has no generated spec and no drift record, so the envelope
    // carries the honest no-baseline state beside `hasSpec: false` — the pair
    // a JSON consumer needs to tell a suppressed drift line from an absent one.
    hasSpec: false,
    drift: { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'unknown', planIsReadable: true },
  });
});

test('runPreflight: reports login-redirect in terminal and JSON when the first direct load lands on the witnessed loginPath', async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
  const locator: LocatorLivenessLocator = { count: async () => 1, nth: () => locator };
  const passwordLocator: LocatorLivenessLocator = { count: async () => 0, nth: () => passwordLocator };
  let currentUrl = 'http://live.example:8000/login';
  const page: LocatorLivenessPage = {
    goto: async () => ({ status: () => 200 }),
    url: () => currentUrl,
    getByTestId: () => locator,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByText: () => locator,
    locator: (selector) => selector === 'input[type=password]' ? passwordLocator : locator,
  };
  const output: string[] = [];
  const sidecar = JSON.stringify({
    version: 1,
    title: 'Account',
    source: { distinctId: 'user-1', sessionId: 'session-1', journeyIndex: 0, generatedAt: '2026-08-22T00:00:00.000Z', tool: 'replaytest@0.1.0' },
    start: '/dashboard',
    auth: { witnessed: true, loginPath: '/login', shape: 'after-login' },
    steps: [{ action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' }],
    assertions: [],
  });

  await runPreflight(['account', '--json'], {
    plansDir: '/fixture/plans',
    pathExists: (filename) => filename === '/fixture/plans/account.plan.json',
    readFile: () => sidecar,
    targetAppUrl: 'http://live.example:8000',
    launchBrowser: async () => ({ newPage: async () => page, close: async () => {} }),
    progress: () => undefined,
    log: (line) => output.push(line),
  });

  const json = JSON.parse(output[0] ?? '') as { verdict: string; authRedirect?: { requestedPath: string; landedPath: string; matchesWitnessedLoginPath: boolean }; steps: Array<{ lane: string; reason: string }> };
  assert.equal(json.verdict, 'inconclusive');
  assert.deepEqual(json.authRedirect, { recordedAction: 1, requestedPath: '/dashboard', landedPath: '/login', matchesWitnessedLoginPath: true, passwordInputPresent: false });
  assert.equal(json.steps[0]?.lane, 'login-redirect');
  assert.match(json.steps[0]?.reason ?? '', /Run auth-setup or set TARGET_APP_STORAGE_STATE/);
  currentUrl = 'http://live.example:8000/dashboard';
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPreflight: password-input corroboration raises login-redirect without a sidecar auth witness', async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const locator: LocatorLivenessLocator = { count: async () => 0, nth: () => locator };
    const passwordLocator: LocatorLivenessLocator = { count: async () => 1, nth: () => passwordLocator };
    const page: LocatorLivenessPage = {
      goto: async () => ({ status: () => 200 }),
      url: () => 'http://live.example:8000/login',
      getByTestId: () => locator,
      getByRole: () => locator,
      getByLabel: () => locator,
      getByPlaceholder: () => locator,
      getByText: () => locator,
      locator: (selector) => selector === 'input[type=password]' ? passwordLocator : locator,
    };
    const output: string[] = [];
    const sidecar = JSON.stringify({
      version: 1,
      title: 'Account without witness',
      source: { distinctId: 'user-1', sessionId: 'session-1', journeyIndex: 0, generatedAt: '2026-08-22T00:00:00.000Z', tool: 'replaytest@0.1.0' },
      start: '/dashboard',
      steps: [{ action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' }],
      assertions: [],
    });

    await runPreflight(['account', '--json'], {
      plansDir: '/fixture/plans',
      pathExists: (filename) => filename === '/fixture/plans/account.plan.json',
      readFile: () => sidecar,
      targetAppUrl: 'http://live.example:8000',
      launchBrowser: async () => ({ newPage: async () => page, close: async () => {} }),
      progress: () => undefined,
      log: (line) => output.push(line),
    });

    const json = JSON.parse(output[0] ?? '') as { verdict: string; authRedirect?: { matchesWitnessedLoginPath: boolean; passwordInputPresent: boolean }; steps: Array<{ lane: string; reason: string }> };
    assert.equal(json.verdict, 'inconclusive');
    assert.deepEqual(json.authRedirect, { recordedAction: 1, requestedPath: '/dashboard', landedPath: '/login', matchesWitnessedLoginPath: false, passwordInputPresent: true });
    assert.equal(json.steps[0]?.lane, 'login-redirect');
    assert.match(json.steps[0]?.reason ?? '', /landed page contains an input\[type=password\]/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPreflight: no-check and dead-selector reports exit non-zero, while partial and fully-passed checks keep their diagnostic success semantics', async () => {
  const originalExitCode = process.exitCode;
  const locator: LocatorLivenessLocator = { count: async () => 1, nth: () => locator };
  const noPasswordLocator: LocatorLivenessLocator = { count: async () => 0, nth: () => noPasswordLocator };
  const page: LocatorLivenessPage = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'http://live.example:8000/first',
    getByTestId: () => locator,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByText: () => locator,
    locator: (selector) => selector === 'input[type=password]' ? noPasswordLocator : locator,
  };
  const browser: LocatorLivenessBrowser = { newPage: async () => page, close: async () => {} };
  const deadLocator: LocatorLivenessLocator = { count: async () => 0, nth: () => deadLocator };
  const deadPage: LocatorLivenessPage = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'http://live.example:8000/first',
    getByTestId: () => deadLocator,
    getByRole: () => deadLocator,
    getByLabel: () => deadLocator,
    getByPlaceholder: () => deadLocator,
    getByText: () => deadLocator,
    locator: (selector) => selector === 'input[type=password]' ? noPasswordLocator : deadLocator,
  };
  const deadBrowser: LocatorLivenessBrowser = { newPage: async () => deadPage, close: async () => {} };
  const sidecar = (secondUrl: string | undefined): string => JSON.stringify({
    version: 1,
    title: 'Checkout',
    source: { distinctId: 'user-1', sessionId: 'session-1', journeyIndex: 0, generatedAt: '2026-08-15T00:00:00.000Z', tool: 'replaytest@0.1.0' },
    start: '/',
    steps: [
      { action: 'click', label: 'First', locator: "getByTestId('first')", url: '/first' },
      { action: 'click', label: 'Second', locator: "getByTestId('second')", ...(secondUrl === undefined ? {} : { url: secondUrl }) },
    ],
    assertions: [],
  });
  const run = async (raw: string, launchBrowser: () => Promise<LocatorLivenessBrowser>): Promise<string> => {
    const output: string[] = [];
    await runPreflight(['checkout'], {
      plansDir: '/fixture/plans',
      pathExists: () => true,
      readFile: () => raw,
      targetAppUrl: 'http://live.example:8000',
      launchBrowser,
      progress: () => undefined,
      log: (line) => output.push(line),
    });
    return output.join('\n');
  };

  try {
    process.exitCode = undefined;
    const inconclusive = await run(sidecar('/second'), async () => { throw new Error('browser unavailable'); });
    assert.equal(process.exitCode, 1);
    assert.match(inconclusive, /INCONCLUSIVE.*gate verified nothing/);

    process.exitCode = undefined;
    const deadSelectors = await run(sidecar('/second'), async () => deadBrowser);
    assert.equal(process.exitCode, 1);
    assert.match(deadSelectors, /DEAD SELECTORS — preflight verified 2 of 2 selectors and found 2 dead/);

    process.exitCode = undefined;
    const partial = await run(sidecar(undefined), async () => browser);
    assert.equal(process.exitCode, undefined);
    assert.match(partial, /PARTIAL — preflight verified 1 of 2 selectors/);

    process.exitCode = undefined;
    const passed = await run(sidecar('/second'), async () => browser);
    assert.equal(process.exitCode, undefined);
    assert.match(passed, /PASSED — all 2 selectors still resolve/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPreflight: forwards a preceding sidecar submit so a direct-load zero-match is gated, not falsely DEAD', async () => {
  const locatorFor = (count: number): LocatorLivenessLocator => ({
    count: async () => count,
    nth: () => locatorFor(count),
  });
  const page: LocatorLivenessPage = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'http://live.example:8000/invoice',
    getByTestId: (testId) => locatorFor(testId === 'submit' ? 1 : 0),
    getByRole: () => locatorFor(0),
    getByLabel: () => locatorFor(0),
    getByPlaceholder: () => locatorFor(0),
    getByText: () => locatorFor(0),
    locator: () => locatorFor(0),
  };
  const browser: LocatorLivenessBrowser = {
    newPage: async () => page,
    close: async () => {},
  };
  const output: string[] = [];
  const sidecar = JSON.stringify({
    version: 1,
    title: 'Checkout',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      generatedAt: '2026-07-22T00:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/',
    steps: [
      { action: 'click', label: 'Pay', locator: "getByTestId('submit')", url: '/invoice', isSubmit: true },
      { action: 'click', label: 'Confirm payment', locator: "getByTestId('confirm-payment')", url: '/invoice' },
    ],
    assertions: [],
  });

  await runPreflight(['checkout', '--json'], {
    plansDir: '/fixture/plans',
    pathExists: (filename) => filename === '/fixture/plans/checkout.plan.json',
    readFile: () => sidecar,
    targetAppUrl: 'http://live.example:8000',
    launchBrowser: async () => browser,
    progress: () => undefined,
    log: (line) => output.push(line),
  });

  const report = JSON.parse(output[0] ?? '') as {
    summary: { totalSelectors: number; resolves: number; dead: number; gatedUnreachable: number; couldntCheck: number };
    steps: Array<{ lane: string; gatedBehindStep?: number; reason: string }>;
  };
  assert.deepEqual(report.summary, { totalSelectors: 2, resolves: 1, dead: 0, gatedUnreachable: 1, couldntCheck: 0 });
  assert.equal(report.steps[1]?.lane, 'gated-unreachable');
  assert.equal(report.steps[1]?.gatedBehindStep, 1);
  assert.match(report.steps[1]?.reason ?? '', /An earlier recorded submit \(recorded action 1\) means a direct load may not reach this state/);
  assert.doesNotMatch(report.steps[1]?.reason ?? '', /alive/i);
});

test('runPreflight: a missing slug uses the existing plan refusal and never attempts a browser or provider read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runPreflight(['missing'], {
      pathExists: () => false,
      readFile: () => {
        throw new Error('readFile must not run for a missing sidecar');
      },
      launchBrowser: async () => {
        throw new Error('launchBrowser must not run for a missing sidecar');
      },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(output, [buildMissingPreflightSidecarError('missing')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

// ---------------------------------------------------------------------------
// Preflight is documented as the FIRST command to run, and
// it checks the PLAN's recorded locators — so a plan that has moved away from
// the generated spec is exactly the caveat a green preflight would otherwise
// hide. These cases drive the real `resolvePlanDrift` through preflight's own
// injected read seams; nothing about the drift state is stubbed.
// ---------------------------------------------------------------------------

const DRIFT_ROOT = '/fixture';
const DRIFT_PLANS_DIR = '/fixture/.replaytest/plans';
const DRIFT_GENERATED_TESTS_DIR = '/fixture/tests/generated';
const DRIFT_PLAN_PATH = `${DRIFT_PLANS_DIR}/checkout.plan.json`;
const DRIFT_SPEC_PATH = `${DRIFT_GENERATED_TESTS_DIR}/checkout.spec.ts`;
const DRIFT_RECORD_PATH = '/fixture/.replaytest/state/spec-emitted-hashes.json';
const DRIFT_SPEC_SOURCE = "import { test } from '@playwright/test';\n// generated\n";

const DRIFTED_CLAIM = '⚠ plan/spec drift — the plan changed while this spec remains untouched machine output; run "replaytest scaffold checkout --force" to re-scaffold.';
const UNKNOWN_CLAIM = 'ⓘ plan/spec state: unknown — this tool has no record of what it last generated for this spec; run "replaytest scaffold checkout --force" to create that record when overwriting the spec is intended.';
const UNVERIFIED_NO_BASELINE_CLAIM = 'ⓘ plan/spec state: unverified — the plan changed; replaytest has no hand-edit baseline for this spec, so it cannot verify the delta was applied.';

function driftPlan(title: string): Sidecar {
  return {
    version: 1,
    title,
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      generatedAt: '2026-08-16T00:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/',
    steps: [{ action: 'click', label: 'Save', locator: "getByTestId('save')", url: '/settings' }],
    assertions: [],
  } as unknown as Sidecar;
}

function driftRecordJson(entry: Partial<SpecEmittedHashEntry>): string {
  return `${JSON.stringify({
    schema: 'replaytest-spec-emitted-hashes/v1',
    algorithm: 'sha256',
    entries: [{
      slug: 'checkout',
      specPath: 'tests/generated/checkout.spec.ts',
      specSha256: hashSpecContent(DRIFT_SPEC_SOURCE),
      generatedAt: '2026-08-16T00:00:00.000Z',
      ...entry,
    }],
  }, null, 2)}\n`;
}

function livenessBrowser(matchCount: number): LocatorLivenessBrowser {
  const locator: LocatorLivenessLocator = { count: async () => matchCount, nth: () => locator };
  const noPasswordLocator: LocatorLivenessLocator = { count: async () => 0, nth: () => noPasswordLocator };
  const page: LocatorLivenessPage = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'http://localhost:8000/',
    getByTestId: () => locator,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByText: () => locator,
    locator: (selector) => selector === 'input[type=password]' ? noPasswordLocator : locator,
  };
  return { newPage: async () => page, close: async () => {} };
}

interface DriftRunResult {
  text: string;
  json: { hasSpec: boolean; drift: PlanDriftState };
  driftLines: string[];
  exitCode: number | string | undefined;
  readPaths: string[];
}

/** One run of the real verb over an in-memory workspace, in both output modes. */
async function runPreflightOver(files: Record<string, string>, matchCount = 1, declared = false): Promise<DriftRunResult> {
  const originalExitCode = process.exitCode;
  const readPaths: string[] = [];
  const deps = {
    plansDir: DRIFT_PLANS_DIR,
    generatedTestsDir: DRIFT_GENERATED_TESTS_DIR,
    workspaceRoot: DRIFT_ROOT,
    targetAppUrl: 'http://live.example:8000',
    pathExists: (filename: string) => Object.hasOwn(files, filename),
    readFile: (filename: string) => {
      readPaths.push(filename);
      const contents = files[filename];
      if (contents === undefined) throw new Error(`ENOENT: no such file, open '${filename}'`);
      return contents;
    },
    launchBrowser: async () => livenessBrowser(matchCount),
    progress: () => undefined,
    ...(declared ? { handFinishedSlugs: new Set(['checkout']) } : {}),
  };
  try {
    process.exitCode = undefined;
    const text: string[] = [];
    await runPreflight(['checkout'], { ...deps, log: (line) => text.push(line) });
    const exitCode = process.exitCode;
    const json: string[] = [];
    await runPreflight(['checkout', '--json'], { ...deps, log: (line) => json.push(line) });
    const rendered = text.join('\n');
    return {
      text: rendered,
      json: JSON.parse(json[0] ?? '{}') as DriftRunResult['json'],
      driftLines: rendered.split('\n').filter((line) => line.includes('plan/spec')),
      exitCode,
      readPaths,
    };
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('runPreflight: a declared spec gets the shared disclosure for unknown state, while a missing declared spec gets stale copy', async () => {
  const unknown = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout')),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
  }, 1, true);
  assert.equal(unknown.json.drift.handFinishedDeclared, true);
  assert.match(unknown.text, /hand-finished spec \(declared\)/);
  assert.deepEqual(survivingScaffoldForceAdvice(unknown.text, 'checkout'), []);

  const stale = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout')),
  }, 1, true);
  assert.equal(stale.json.hasSpec, false);
  assert.equal(stale.json.drift.handFinishedStale, true);
  assert.match(stale.text, /declared hand-finished, but its spec file is absent/);

  const baseline = driftPlan('Checkout');
  const conflict = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout, changed after generation')),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
    [DRIFT_RECORD_PATH]: driftRecordJson({ planSha256: hashPlanSidecarContent(baseline), planHashDomain: PLAN_HASH_DOMAIN }),
  }, 1, true);
  assert.equal(conflict.json.drift.handFinishedDeclared, true);
  assert.equal(conflict.json.drift.verdict, 'drifted');
  assert.match(conflict.text, /conflicting state: this spec is declared hand-finished but carries a machine baseline/);
  assert.deepEqual(survivingScaffoldForceAdvice(conflict.text, 'checkout'), []);

  const current = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(baseline),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
    [DRIFT_RECORD_PATH]: driftRecordJson({ planSha256: hashPlanSidecarContent(baseline), planHashDomain: PLAN_HASH_DOMAIN }),
  }, 1, true);
  assert.equal(current.json.drift.verdict, 'current');
  assert.match(current.text, /conflicting state: this spec is declared hand-finished but carries a machine baseline/);
  assert.deepEqual(survivingScaffoldForceAdvice(current.text, 'checkout'), []);
});

test('runPreflight: a changed plan against an untouched generated spec reports confident drift, in the same words as heal and suite-status', async () => {
  const baseline = driftPlan('Checkout');
  const result = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout, renamed by hand')),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
    [DRIFT_RECORD_PATH]: driftRecordJson({ planSha256: hashPlanSidecarContent(baseline), planHashDomain: PLAN_HASH_DOMAIN }),
  });

  // The literal is pinned here, in heal.test.ts and in suite-status.test.ts:
  // rewording the one shared claim takes all three surfaces RED, which is the
  // point of having one source for it.
  assert.deepEqual(result.driftLines, [DRIFTED_CLAIM], 'exactly one drift line, and it is the shared confident-drift claim');
  assert.equal(result.text.split('\n').pop(), DRIFTED_CLAIM);
  // Drift rows are informational: a drifted pair whose selectors all resolve
  // is still a passing preflight. They never change the exit-code contract.
  assert.equal(result.exitCode, undefined);
  assert.match(result.text, /PASSED — all 1 selectors still resolve/);
  assert.equal(result.json.hasSpec, true);
  assert.deepEqual(result.json.drift, {
    verdict: 'drifted',
    keying: 'content-hash/v1',
    handEditStatus: 'stamped-clean',
    planIsReadable: true,
  });
});

test('runPreflight: a plan that still matches its generation baseline says nothing about drift at all', async () => {
  const plan = driftPlan('Checkout');
  const result = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(plan),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
    [DRIFT_RECORD_PATH]: driftRecordJson({ planSha256: hashPlanSidecarContent(plan), planHashDomain: PLAN_HASH_DOMAIN }),
  });

  assert.deepEqual(result.driftLines, [], 'a current pair is silent — no reassurance line, no advisory');
  assert.equal(result.json.drift.verdict, 'current');
  assert.equal(result.json.drift.handEditStatus, 'stamped-clean');
});

test('runPreflight: a record from before plan baselines with no plan baseline reports the honest unknown state and publishes the REAL hand-edit axis', async () => {
  const result = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout')),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
    [DRIFT_RECORD_PATH]: driftRecordJson({}),
  });

  assert.deepEqual(result.driftLines, [UNKNOWN_CLAIM]);
  assert.deepEqual(result.json.drift, {
    verdict: 'unknown',
    keying: 'content-hash/v1',
    // Not fabricated: this record still carries a spec baseline, so the
    // hand-edit axis IS evaluable even with no plan hash.
    handEditStatus: 'stamped-clean',
    planIsReadable: true,
  });
});

test('runPreflight: a failing run keeps its own instruction — the no-baseline advisory waits, while confident drift is still stated', async () => {
  const noBaseline = {
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout')),
    [DRIFT_SPEC_PATH]: DRIFT_SPEC_SOURCE,
    [DRIFT_RECORD_PATH]: driftRecordJson({}),
  };
  const deadRun = await runPreflightOver(noBaseline, 0);
  assert.equal(deadRun.exitCode, 1);
  assert.match(deadRun.text, /DEAD SELECTORS — preflight verified 1 of 1 selectors and found 1 dead/);
  assert.deepEqual(deadRun.driftLines, [], 'one row, one instruction — never two competing orders');
  // Suppressed on the terminal, still published to a JSON consumer.
  assert.equal(deadRun.json.drift.verdict, 'unknown');

  const drifted = await runPreflightOver({
    ...noBaseline,
    [DRIFT_RECORD_PATH]: driftRecordJson({ planSha256: hashPlanSidecarContent(driftPlan('Checkout, renamed by hand')), planHashDomain: PLAN_HASH_DOMAIN }),
  }, 0);
  assert.equal(drifted.exitCode, 1);
  assert.deepEqual(drifted.driftLines, [DRIFTED_CLAIM], 'a confident drift finding is stated even on a failing run, as it is on heal');
});

test('runPreflight: a plan it could not read makes no drift claim, and never even consults the drift record', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    const readPaths: string[] = [];
    await runPreflight(['checkout'], {
      plansDir: DRIFT_PLANS_DIR,
      generatedTestsDir: DRIFT_GENERATED_TESTS_DIR,
      workspaceRoot: DRIFT_ROOT,
      pathExists: () => true,
      readFile: (filename) => {
        readPaths.push(filename);
        return filename === DRIFT_PLAN_PATH ? '{' : driftRecordJson({});
      },
      launchBrowser: async () => {
        throw new Error('launchBrowser must not run for an invalid sidecar');
      },
      progress: () => undefined,
      log: (line) => output.push(line),
    });

    assert.equal(process.exitCode, 1);
    assert.equal(output.length, 1);
    // The JSON engine's own parse message is quoted verbatim and varies by
    // Node version, so the refusal is matched on its own wording.
    assert.match(output[0] ?? '', /^Cannot preflight "checkout": invalid sidecar \(.+\)\. Run `replaytest plan <distinctId>` to make a fresh plan\.$/);
    assert.equal(output.join('\n').includes('plan/spec'), false, 'an unreadable plan gets no drift verdict, not even "unknown"');
    assert.deepEqual(readPaths, [DRIFT_PLAN_PATH], 'the refusal returns before any drift read');
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runPreflight: a plan with no scaffolded spec suppresses the drift row but still publishes the state beside hasSpec', async () => {
  const result = await runPreflightOver({
    [DRIFT_PLAN_PATH]: JSON.stringify(driftPlan('Checkout, renamed by hand')),
    [DRIFT_RECORD_PATH]: driftRecordJson({ planSha256: hashPlanSidecarContent(driftPlan('Checkout')), planHashDomain: PLAN_HASH_DOMAIN }),
  });

  assert.equal(result.json.hasSpec, false);
  assert.deepEqual(result.json.drift, {
    verdict: 'unverified',
    keying: 'content-hash/v1',
    // A spec that is not on disk is not evidence of a hand edit.
    handEditStatus: 'unknown',
    planIsReadable: true,
  });
  assert.deepEqual(result.driftLines, [], 'no spec on disk means no plan/spec advice to give');
  assert.equal(result.text.includes(UNVERIFIED_NO_BASELINE_CLAIM), false);
});
