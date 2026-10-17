import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TARGET_APP_URL,
  applyRecordedLocator,
  collectLocatorLiveness,
  formatLocatorLivenessJson,
  parseRecordedLocator,
  renderLocatorLivenessReport,
  targetUrlForRecordedPage,
  type LocatorLivenessBrowser,
  type LocatorLivenessLocator,
  type LocatorLivenessPage,
} from './locator-liveness.js';

interface FakePageOptions {
  responses?: Record<string, number | Error | null>;
  counts?: Record<string, number | Error>;
  finalUrls?: Record<string, string>;
}

class FakeLocator implements LocatorLivenessLocator {
  constructor(
    private readonly key: string,
    private readonly counts: Record<string, number | Error>,
  ) {}

  async count(): Promise<number> {
    const result = this.counts[this.key];
    if (result instanceof Error) throw result;
    return result ?? 0;
  }

  nth(index: number): LocatorLivenessLocator {
    return new FakeLocator(`${this.key}.nth(${index})`, this.counts);
  }
}

class FakePage implements LocatorLivenessPage {
  readonly visits: string[] = [];
  private currentUrl = '';

  constructor(private readonly options: FakePageOptions = {}) {}

  async goto(url: string): Promise<{ status(): number } | null> {
    this.visits.push(url);
    this.currentUrl = this.options.finalUrls?.[url] ?? url;
    const response = this.options.responses?.[url] ?? 200;
    if (response instanceof Error) throw response;
    if (response === null) return null;
    return { status: () => response };
  }

  url(): string {
    return this.currentUrl;
  }

  getByTestId(testId: string): LocatorLivenessLocator {
    return new FakeLocator(`getByTestId:${testId}`, this.options.counts ?? {});
  }

  getByRole(role: string, options?: { name?: string }): LocatorLivenessLocator {
    return new FakeLocator(`getByRole:${role}:${options?.name ?? ''}`, this.options.counts ?? {});
  }

  getByLabel(label: string): LocatorLivenessLocator {
    return new FakeLocator(`getByLabel:${label}`, this.options.counts ?? {});
  }

  getByPlaceholder(placeholder: string): LocatorLivenessLocator {
    return new FakeLocator(`getByPlaceholder:${placeholder}`, this.options.counts ?? {});
  }

  getByText(text: string): LocatorLivenessLocator {
    return new FakeLocator(`getByText:${text}`, this.options.counts ?? {});
  }

  locator(selector: string): LocatorLivenessLocator {
    return new FakeLocator(`locator:${selector}`, this.options.counts ?? {});
  }
}

function browserFor(page: FakePage): LocatorLivenessBrowser & { closed: boolean } {
  return {
    closed: false,
    newPage: async () => page,
    close: async function close(): Promise<void> {
      this.closed = true;
    },
  };
}

test('collectLocatorLiveness: reports resolves (including multiple), DEAD, and direct-goto unavailable separately', async () => {
  const baseUrl = 'http://live.example:8000';
  const page = new FakePage({
    responses: {
      'http://live.example:8000/unreachable': new Error('net::ERR_CONNECTION_REFUSED'),
      'http://live.example:8000/gone': 404,
    },
    counts: {
      'getByTestId:one': 1,
      'getByRole:button:Many': 2,
      'locator:#missing': 0,
    },
  });
  const browser = browserFor(page);

  const report = await collectLocatorLiveness({
    steps: [
      { action: 'click', label: 'One', locator: "getByTestId('one')", url: 'https://recorded.example/one' },
      { action: 'click', label: 'Many', locator: "getByRole('button', { name: 'Many' })", url: '/many' },
      { action: 'fill', label: 'Missing', locator: "locator('#missing')", url: '/missing' },
      { action: 'click', label: 'Unreachable', locator: "getByTestId('never')", url: '/unreachable' },
      { action: 'click', label: 'Gone', locator: "getByTestId('gone')", url: '/gone' },
    ],
  }, {
    targetAppUrl: baseUrl,
    launchBrowser: async () => browser,
  });

  assert.deepEqual(report.summary, { totalSelectors: 5, resolves: 2, dead: 1, gatedUnreachable: 0, couldntCheck: 2 });
  assert.deepEqual(report.steps.map((step) => ({ lane: step.lane, count: step.count })), [
    { lane: 'resolves', count: 1 },
    { lane: 'resolves', count: 2 },
    { lane: 'DEAD', count: 0 },
    { lane: "couldn't check", count: undefined },
    { lane: "couldn't check", count: undefined },
  ]);
  assert.equal(report.steps[1]?.reason, '2 matching elements on a page that returned HTTP 200 (more than one resolves).');
  assert.match(report.steps[3]?.reason ?? '', /Couldn\'t open the recorded page directly: net::ERR_CONNECTION_REFUSED/);
  assert.equal(report.steps[4]?.reason, "Couldn't check because the page returned HTTP 404 when opened directly.");
  assert.deepEqual(page.visits, [
    'http://live.example:8000/one',
    'http://live.example:8000/many',
    'http://live.example:8000/missing',
    'http://live.example:8000/unreachable',
    'http://live.example:8000/gone',
  ]);
  assert.equal(browser.closed, true);
});

test('collectLocatorLiveness: names an observed first-load login redirect and carries the JSON auth finding', async () => {
  const page = new FakePage({
    finalUrls: { 'http://live.example/dashboard': 'http://live.example/login' },
    counts: { 'getByTestId:dashboard': 1, 'locator:input[type=password]': 1 },
  });
  const report = await collectLocatorLiveness({
    auth: { loginPath: '/login' },
    steps: [{ action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' }],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(page) });

  assert.equal(report.steps[0]?.lane, 'login-redirect');
  assert.match(report.steps[0]?.reason ?? '', /matching the login path witnessed in this plan's recording/);
  assert.match(report.steps[0]?.reason ?? '', /The recorded locator for this step was not checked, so it is reported as neither resolved nor dead\./);
  assert.deepEqual(report.authRedirect, {
    recordedAction: 1,
    requestedPath: '/dashboard',
    landedPath: '/login',
    matchesWitnessedLoginPath: true,
    passwordInputPresent: true,
  });
  assert.equal(report.summary.loginRedirect, 1);
});

test('collectLocatorLiveness: password corroboration is named, while a password field without redirect stays ordinary', async () => {
  const redirectedPage = new FakePage({
    finalUrls: { 'http://live.example/dashboard': 'http://live.example/sign-in' },
    counts: { 'getByTestId:dashboard': 1, 'locator:input[type=password]': 1 },
  });
  const redirected = await collectLocatorLiveness({
    auth: { loginPath: '/login' },
    steps: [{ action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' }],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(redirectedPage) });
  assert.equal(redirected.steps[0]?.lane, 'login-redirect');
  assert.match(redirected.steps[0]?.reason ?? '', /landed page contains an input\[type=password\]/);
  assert.equal(redirected.authRedirect?.matchesWitnessedLoginPath, false);

  const samePage = new FakePage({
    finalUrls: { 'http://live.example/dashboard': 'http://live.example/dashboard' },
    counts: { 'getByTestId:dashboard': 1, 'locator:input[type=password]': 1 },
  });
  const ordinary = await collectLocatorLiveness({
    auth: { loginPath: '/login' },
    steps: [{ action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' }],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(samePage) });
  assert.equal(ordinary.steps[0]?.lane, 'resolves');
  assert.equal(ordinary.authRedirect, undefined);
});

test('collectLocatorLiveness: a generic first-load redirect stays ordinary without either auth corroborator', async () => {
  const page = new FakePage({
    finalUrls: { 'http://live.example/dashboard': 'http://live.example/marketing' },
    counts: { 'getByTestId:dashboard': 1, 'locator:input[type=password]': 0 },
  });
  const report = await collectLocatorLiveness({
    auth: { loginPath: '/login' },
    steps: [{ action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' }],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(page) });

  assert.equal(report.steps[0]?.lane, 'resolves');
  assert.equal(report.steps[0]?.authRedirect, undefined);
  assert.equal(report.authRedirect, undefined);
});

test('collectLocatorLiveness: a later-step redirect never raises the first-load login finding', async () => {
  const page = new FakePage({
    finalUrls: {
      'http://live.example/dashboard': 'http://live.example/dashboard',
      'http://live.example/settings': 'http://live.example/sign-in',
    },
    counts: {
      'getByTestId:dashboard': 1,
      'getByTestId:settings': 1,
      'locator:input[type=password]': 1,
    },
  });
  const report = await collectLocatorLiveness({
    auth: { loginPath: '/login' },
    steps: [
      { action: 'click', label: 'Dashboard', locator: "getByTestId('dashboard')", url: '/dashboard' },
      { action: 'click', label: 'Settings', locator: "getByTestId('settings')", url: '/settings' },
    ],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(page) });

  assert.deepEqual(report.steps.map((step) => step.lane), ['resolves', 'resolves']);
  assert.equal(report.authRedirect, undefined);
  assert.equal(report.summary.loginRedirect, undefined);
});

test('collectLocatorLiveness: never guesses a missing historical page and does not launch a browser when every step is unavailable', async () => {
  let launches = 0;
  const report = await collectLocatorLiveness({
    steps: [
      { action: 'click', label: 'Legacy', locator: "getByTestId('legacy')" },
      { action: 'fill', label: 'No selector', locator: '', url: '/form' },
    ],
  }, {
    targetAppUrl: 'http://live.example',
    launchBrowser: async () => {
      launches += 1;
      throw new Error('must not start');
    },
  });

  assert.equal(launches, 0);
  assert.deepEqual(report.summary, { totalSelectors: 2, resolves: 0, dead: 0, gatedUnreachable: 0, couldntCheck: 2 });
  assert.equal(report.steps[0]?.reason, "Couldn't check because this sidecar does not record the page for this action.");
  assert.equal(report.steps[1]?.reason, "Couldn't check because no locator was recorded for this action.");
});

test("collectLocatorLiveness: mixed new and legacy step URLs select resolves, DEAD, and couldn't-check lanes per action", async () => {
  const page = new FakePage({ counts: { 'getByTestId:live': 1, 'getByTestId:gone': 0 } });
  const report = await collectLocatorLiveness({
    steps: [
      { action: 'click', label: 'Live', locator: "getByTestId('live')", url: '/live' },
      { action: 'click', label: 'Gone', locator: "getByTestId('gone')", url: '/gone' },
      { action: 'click', label: 'Legacy', locator: "getByTestId('legacy')" },
    ],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(page) });

  assert.deepEqual(report.summary, { totalSelectors: 3, resolves: 1, dead: 1, gatedUnreachable: 0, couldntCheck: 1 });
  assert.deepEqual(report.steps.map((step) => step.lane), ['resolves', 'DEAD', "couldn't check"]);
  assert.deepEqual(page.visits, ['http://live.example/live', 'http://live.example/gone']);
  assert.equal(report.steps[2]?.reason, "Couldn't check because this sidecar does not record the page for this action.");
});

test("collectLocatorLiveness: local browser and unsupported-locator failures remain couldn't check, not DEAD", async () => {
  const browserFailure = await collectLocatorLiveness({
    steps: [{ action: 'click', label: 'One', locator: "getByTestId('one')", url: '/' }],
  }, {
    targetAppUrl: 'http://live.example',
    launchBrowser: async () => {
      throw new Error('browser executable is missing');
    },
  });
  assert.deepEqual(browserFailure.summary, { totalSelectors: 1, resolves: 0, dead: 0, gatedUnreachable: 0, couldntCheck: 1 });
  assert.match(browserFailure.steps[0]?.reason ?? '', /Couldn\'t start a local Playwright browser/);

  const page = new FakePage();
  const unsupported = await collectLocatorLiveness({
    steps: [{ action: 'click', label: 'Custom', locator: "getByText('Custom').first()", url: '/' }],
  }, {
    targetAppUrl: 'http://live.example',
    launchBrowser: async () => browserFor(page),
  });
  assert.deepEqual(unsupported.summary, { totalSelectors: 1, resolves: 0, dead: 0, gatedUnreachable: 0, couldntCheck: 1 });
  assert.match(unsupported.steps[0]?.reason ?? '', /Couldn\'t apply the recorded locator/);
  assert.deepEqual(page.visits, ['http://live.example/']);
});

test('recorded URLs are always mapped to TARGET_APP_URL rather than revisiting the recorded origin', () => {
  assert.deepEqual(
    targetUrlForRecordedPage('https://production.example/orders/42?print=1#receipt', 'http://localhost:8000/base'),
    { kind: 'ok', value: 'http://localhost:8000/orders/42?print=1#receipt' },
  );
  const invalid = targetUrlForRecordedPage('/orders/42', 'not a url');
  assert.equal(invalid.kind, 'invalid');
  assert.match(invalid.reason, /Couldn\'t check because the recorded page or TARGET_APP_URL is not a usable URL/);
});

test('applyRecordedLocator supports every selector ladder expression without evaluating arbitrary plan text', async () => {
  const page = new FakePage({
    counts: {
      'getByTestId:save': 1,
      'getByRole:button:Save': 2,
      'getByLabel:Billing name': 3,
      'getByPlaceholder:Jane Doe': 4,
      'getByText:Continue': 5,
      'locator:input:nth-child(2).nth(0)': 6,
    },
  });

  const sources = [
    "getByTestId('save')",
    "getByRole('button', { name: 'Save' })",
    "getByLabel('Billing name')",
    "getByPlaceholder('Jane Doe')",
    "getByText('Continue')",
    "locator('input:nth-child(2)').nth(0)",
  ];
  const counts = await Promise.all(sources.map((source) => applyRecordedLocator(page, source).count()));
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseRecordedLocator("getByRole('button')"), { kind: 'role', role: 'button' });
  assert.throws(() => parseRecordedLocator("getByText('Continue').first()"), /unsupported locator expression/);
});

test('renderers keep the four human-facing lanes and JSON carries the same rows plus base-URL provenance', async () => {
  const page = new FakePage({ counts: { 'getByTestId:one': 1, 'locator:#gone': 0 } });
  const report = await collectLocatorLiveness({
    steps: [
      { action: 'click', label: 'One', locator: "getByTestId('one')", url: '/' },
      { action: 'fill', label: 'Gone', locator: "locator('#gone')", url: '/form' },
      { action: 'click', label: 'Later', locator: "getByTestId('later')" },
    ],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(page) });

  const terminal = renderLocatorLivenessReport(report);
  assert.match(terminal, /^Preflight base URL: http:\/\/live\.example \(option\)\. Recorded page paths are joined onto this base; per-step URLs are in --json\.\nDEAD SELECTORS — preflight verified 2 of 3 selectors and found 1 dead\. 1 of 3 selectors still resolve; 1 dead; 0 gated-unreachable; 1 couldn't be checked\./);
  assert.doesNotMatch(terminal, /CHECKED —/);
  assert.match(terminal, /recorded action 2: fill "Gone" \| locator: locator\('#gone'\) \| DEAD/);
  assert.match(terminal, /recorded action 3: click "Later" .* couldn't check/);

  const json = JSON.parse(formatLocatorLivenessJson(report, 'checkout')) as {
    slug: string;
    verdict: string;
    baseUrl: string;
    baseUrlSource: string;
    targetAppUrl: string;
    summary: unknown;
    steps: Array<{ lane: string }>;
  };
  assert.equal(json.slug, 'checkout');
  assert.equal(json.verdict, 'dead-selectors-found');
  assert.equal(json.baseUrl, 'http://live.example');
  assert.equal(json.baseUrlSource, 'option');
  assert.equal(json.targetAppUrl, 'http://live.example');
  assert.deepEqual(json.summary, report.summary);
  assert.deepEqual(json.steps.map((step) => step.lane), ['resolves', 'DEAD', "couldn't check"]);
});

test('collectLocatorLiveness: a direct-load zero-match after any preceding submit is gated-unreachable, while a pre-submit zero-match stays DEAD', async () => {
  const page = new FakePage({
    counts: {
      'getByTestId:pre-submit-dead': 0,
      'getByTestId:submit': 1,
      'getByTestId:confirm-payment': 0,
      'getByTestId:back-to-invoice': 0,
    },
  });
  const report = await collectLocatorLiveness({
    steps: [
      { action: 'click', label: 'Old control', locator: "getByTestId('pre-submit-dead')", url: '/invoice' },
      { action: 'click', label: 'Pay invoice', locator: "getByTestId('submit')", url: '/invoice', isSubmit: true },
      { action: 'click', label: 'Confirm payment', locator: "getByTestId('confirm-payment')", url: '/invoice' },
      { action: 'click', label: 'Back to invoice', locator: "getByTestId('back-to-invoice')", url: '/paid' },
    ],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(page) });

  assert.deepEqual(report.summary, { totalSelectors: 4, resolves: 1, dead: 1, gatedUnreachable: 2, couldntCheck: 0 });
  assert.deepEqual(report.steps.map((step) => step.lane), ['DEAD', 'resolves', 'gated-unreachable', 'gated-unreachable']);
  assert.equal(report.steps[0]?.reason, 'Page loaded directly (HTTP 200), but the locator matched no elements.');
  assert.equal(
    report.steps[2]?.reason,
    "An earlier recorded submit (recorded action 2) means a direct load may not reach this state; couldn't check without interaction — run the full spec to verify.",
  );
  assert.equal(report.steps[2]?.gatedBehindStep, 2);
  assert.equal(report.steps[3]?.gatedBehindStep, 2);
  assert.doesNotMatch(report.steps[2]?.reason ?? '', /alive/i);
  assert.match(
    renderLocatorLivenessReport(report),
    /DEAD SELECTORS — preflight verified 2 of 4 selectors and found 1 dead\. 1 of 4 selectors still resolve; 1 dead; 2 gated-unreachable; 0 couldn't be checked\./,
  );
});

test('renderLocatorLivenessReport: a no-check report is visibly inconclusive and says the gate verified nothing', () => {
  const report = {
    baseUrl: 'http://live.example',
    baseUrlSource: 'option' as const,
    targetAppUrl: 'http://live.example',
    summary: { totalSelectors: 2, resolves: 0, dead: 0, gatedUnreachable: 0, couldntCheck: 2 },
    steps: [],
  };
  const terminal = renderLocatorLivenessReport(report);
  assert.match(terminal, /INCONCLUSIVE — preflight verified no selectors; the gate verified nothing/);
  assert.doesNotMatch(terminal, /PASSED/);
  const json = JSON.parse(formatLocatorLivenessJson(report, 'checkout')) as { verdict: string };
  assert.equal(json.verdict, 'inconclusive');
});

test('collectLocatorLiveness: names an env base URL without warning and names the default with a warning when TARGET_APP_URL is unset', async () => {
  const originalTargetAppUrl = process.env.TARGET_APP_URL;
  const plan = {
    steps: [{ action: 'click' as const, label: 'Save', locator: "getByTestId('save')", url: '/' }],
  };
  try {
    process.env.TARGET_APP_URL = 'http://configured.example:9000';
    const configured = await collectLocatorLiveness(plan, {
      launchBrowser: async () => browserFor(new FakePage({ counts: { 'getByTestId:save': 1 } })),
    });
    assert.equal(configured.baseUrl, 'http://configured.example:9000');
    assert.equal(configured.baseUrlSource, 'env');
    assert.match(renderLocatorLivenessReport(configured), /^Preflight base URL: http:\/\/configured\.example:9000 \(TARGET_APP_URL\)\. Recorded page paths are joined onto this base; per-step URLs are in --json\./);
    assert.doesNotMatch(renderLocatorLivenessReport(configured), /WARNING:/);

    delete process.env.TARGET_APP_URL;
    const fallback = await collectLocatorLiveness(plan, {
      launchBrowser: async () => browserFor(new FakePage({ counts: { 'getByTestId:save': 1 } })),
    });
    assert.equal(fallback.baseUrl, 'http://localhost:8000');
    assert.equal(fallback.baseUrlSource, 'default');
    assert.match(renderLocatorLivenessReport(fallback), /^Preflight base URL: http:\/\/localhost:8000 \(default\)\. Recorded page paths are joined onto this base; per-step URLs are in --json\.\nWARNING: TARGET_APP_URL is unset; using default base URL http:\/\/localhost:8000\./);
  } finally {
    if (originalTargetAppUrl === undefined) delete process.env.TARGET_APP_URL;
    else process.env.TARGET_APP_URL = originalTargetAppUrl;
  }
});

test('renderLocatorLivenessReport only points to per-step JSON URLs when a recorded URL was usable', async () => {
  const report = await collectLocatorLiveness({
    steps: [{ action: 'click', label: 'Save', locator: "getByTestId('save')" }],
  }, { targetAppUrl: 'http://live.example', launchBrowser: async () => browserFor(new FakePage({ counts: { 'getByTestId:save': 1 } })) });

  const terminal = renderLocatorLivenessReport(report);
  assert.match(terminal, /^Preflight base URL: http:\/\/live\.example \(option\)\. Recorded page paths are joined onto this base\./);
  assert.doesNotMatch(terminal, /--json/);
});

test('collectLocatorLiveness: treats empty or whitespace TARGET_APP_URL as an explicitly warned default fallback', async () => {
  const originalTargetAppUrl = process.env.TARGET_APP_URL;
  const plan = {
    steps: [{ action: 'click' as const, label: 'Save', locator: "getByTestId('save')", url: '/' }],
  };
  try {
    for (const emptyValue of ['', '   ']) {
      process.env.TARGET_APP_URL = emptyValue;
      const report = await collectLocatorLiveness(plan, {
        launchBrowser: async () => browserFor(new FakePage({ counts: { 'getByTestId:save': 1 } })),
      });
      assert.equal(report.baseUrl, DEFAULT_TARGET_APP_URL);
      assert.equal(report.baseUrlSource, 'default');
      assert.equal(report.baseUrlFallbackReason, 'empty-target-app-url');
      assert.equal(
        (JSON.parse(formatLocatorLivenessJson(report, 'checkout')) as { baseUrlFallbackReason?: string }).baseUrlFallbackReason,
        'empty-target-app-url',
      );
      assert.match(
        renderLocatorLivenessReport(report),
        /WARNING: TARGET_APP_URL was set but empty or whitespace; using default base URL http:\/\/localhost:8000\./,
      );
    }
  } finally {
    if (originalTargetAppUrl === undefined) delete process.env.TARGET_APP_URL;
    else process.env.TARGET_APP_URL = originalTargetAppUrl;
  }
});
