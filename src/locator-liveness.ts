/**
 * Local locator-liveness preflight.
 *
 * This module deliberately knows only about a reviewed LOCAL plan and a live
 * browser page. It imports no provider adapter and makes no provider call:
 * `preflight` answers a narrow question — does each recorded locator still
 * resolve on the recorded page when that page is opened directly today?
 *
 * A direct visit cannot recreate post-submit or authenticated state. A
 * successful direct-load zero-match after a recorded submit is therefore a
 * distinct gated-unreachable result, never a false DEAD or a claim that the
 * element is alive. Fresh traffic triage remains the complementary tool for
 * learning what a dead selector became; this module intentionally does not
 * attempt that inference.
 */

export const DEFAULT_TARGET_APP_URL = 'http://localhost:8000';

export type LocatorLivenessLane = 'resolves' | 'DEAD' | 'gated-unreachable' | 'login-redirect' | "couldn't check";

/** Whether the base URL came from an injected option, TARGET_APP_URL, or the intentionally loud fallback. */
export type LocatorLivenessBaseUrlSource = 'option' | 'env' | 'default';

/** Why the default base URL was selected, when no usable explicit value was available. */
export type LocatorLivenessBaseUrlFallbackReason = 'unset' | 'empty-target-app-url';

/** Machine-readable outcome for a preflight run; `dead-selectors-found` wins over partial progress. */
export type LocatorLivenessVerdict = 'inconclusive' | 'passed' | 'dead-selectors-found' | 'partial';

/** The deliberately small, browser-library-independent plan view. */
export interface LocatorLivenessPlan {
  steps: readonly LocatorLivenessPlanStep[];
  /** The literal login pathname witnessed by this plan's persisted sidecar, when present. */
  auth?: LocatorLivenessAuth;
}

export interface LocatorLivenessAuth {
  loginPath: string;
}

/**
 * `url` is optional for backward compatibility with older sidecars. A step
 * that lacks the recorded page is not guessed from another step or from the
 * plan start: that missing evidence is reported as "couldn't check".
 */
export interface LocatorLivenessPlanStep {
  action: 'fill' | 'click';
  label: string;
  locator: string;
  url?: string;
  /** A preceding submit makes a direct-load zero-match unverifiable, not DEAD. */
  isSubmit?: boolean;
}

export interface LocatorLivenessResponse {
  status(): number;
}

export interface LocatorLivenessLocator {
  count(): Promise<number>;
  nth(index: number): LocatorLivenessLocator;
}

/** The subset of Playwright's Page surface the preflight needs. */
export interface LocatorLivenessPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' }): Promise<LocatorLivenessResponse | null>;
  /** Final URL after the browser follows any redirects from `goto`. */
  url(): string;
  getByTestId(testId: string): LocatorLivenessLocator;
  getByRole(role: string, options?: { name?: string }): LocatorLivenessLocator;
  getByLabel(label: string): LocatorLivenessLocator;
  getByPlaceholder(placeholder: string): LocatorLivenessLocator;
  getByText(text: string): LocatorLivenessLocator;
  locator(selector: string): LocatorLivenessLocator;
}

/** The subset of Playwright's Browser surface the preflight needs. */
export interface LocatorLivenessBrowser {
  newPage(): Promise<LocatorLivenessPage>;
  close(): Promise<void>;
}

export type LocatorLivenessBrowserLauncher = () => Promise<LocatorLivenessBrowser>;

export interface LocatorLivenessOptions {
  /** Defaults to TARGET_APP_URL, then the generated-spec default localhost:8000. */
  targetAppUrl?: string;
  launchBrowser?: LocatorLivenessBrowserLauncher;
}

export interface LocatorLivenessStepResult {
  recordedAction: number;
  action: 'fill' | 'click';
  label: string;
  locator: string;
  /** The page captured with this action, when the sidecar carries it. */
  recordedUrl?: string;
  /** The TARGET_APP_URL-based URL actually opened, when it could be constructed. */
  liveUrl?: string;
  lane: LocatorLivenessLane;
  /** Observation that a first direct load redirected into a login-shaped page. */
  authRedirect?: LocatorLivenessAuthRedirect;
  /** Present only when the locator was counted on a successfully loaded page. */
  count?: number;
  /** Recorded-action ordinal of the earlier submit that makes this direct-load zero-match unverifiable. */
  gatedBehindStep?: number;
  /** Human-readable evidence for every lane, including direct-goto failures. */
  reason: string;
}

export interface LocatorLivenessSummary {
  totalSelectors: number;
  resolves: number;
  dead: number;
  gatedUnreachable: number;
  couldntCheck: number;
  /** Additive: present only when a login-redirect finding was observed. */
  loginRedirect?: number;
}

export interface LocatorLivenessAuthRedirect {
  recordedAction: number;
  requestedPath: string;
  landedPath: string;
  matchesWitnessedLoginPath: boolean;
  passwordInputPresent: boolean;
}

export interface LocatorLivenessReport {
  /** The base URL recorded paths are joined onto. A path prefix may be dropped by URL join; each step's liveUrl is the exact URL visited. */
  baseUrl: string;
  baseUrlSource: LocatorLivenessBaseUrlSource;
  /** Present only when the default base URL was selected instead of TARGET_APP_URL. */
  baseUrlFallbackReason?: LocatorLivenessBaseUrlFallbackReason;
  /** @deprecated Use baseUrl. Retained for JSON consumers as an additive compatibility field. */
  targetAppUrl: string;
  summary: LocatorLivenessSummary;
  steps: LocatorLivenessStepResult[];
  /** Top-level JSON hand-off for the named auth finding; absent when no redirect was observed. */
  authRedirect?: LocatorLivenessAuthRedirect;
}

type ParsedLocator =
  | { kind: 'testid'; value: string }
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'label'; value: string }
  | { kind: 'placeholder'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'css'; value: string; nth?: number };

const SINGLE_QUOTED = "'((?:\\\\.|[^'])*)'";

/**
 * Checks each step independently from a fresh direct `goto`. That is
 * intentional: following the flow would turn this cheap selector diagnostic
 * into a potentially write-producing test run, and would hide which recorded
 * page itself can no longer be opened directly.
 */
export async function collectLocatorLiveness(
  plan: LocatorLivenessPlan,
  options: LocatorLivenessOptions = {},
): Promise<LocatorLivenessReport> {
  const { baseUrl, baseUrlSource, baseUrlFallbackReason } = resolveBaseUrl(options);
  const pending: InitialStepResult[] = [];
  let precedingSubmitStep: number | undefined;
  for (const [index, step] of plan.steps.entries()) {
    pending.push(initialStepResult(step, index + 1, baseUrl, precedingSubmitStep));
    if (step.isSubmit === true) precedingSubmitStep = index + 1;
  }
  const checkable = pending.filter(isPendingStepResult);

  if (checkable.length === 0) return finalizeReport(baseUrl, baseUrlSource, baseUrlFallbackReason, pending);

  let browser: LocatorLivenessBrowser;
  try {
    browser = await (options.launchBrowser ?? launchLocalBrowser)();
  } catch (error) {
    const reason = `Couldn't start a local Playwright browser: ${errorDetail(error)}.`;
    return finalizeReport(baseUrl, baseUrlSource, baseUrlFallbackReason, pending.map((entry) =>
      isPendingStepResult(entry) ? couldntCheck(entry, reason) : entry,
    ));
  }

  try {
    let page: LocatorLivenessPage;
    try {
      page = await browser.newPage();
    } catch (error) {
      const reason = `Couldn't open a local Playwright page: ${errorDetail(error)}.`;
      return finalizeReport(baseUrl, baseUrlSource, baseUrlFallbackReason, pending.map((entry) =>
        isPendingStepResult(entry) ? couldntCheck(entry, reason) : entry,
      ));
    }

    const checked: LocatorLivenessStepResult[] = [];
    for (const entry of pending) {
      if (!isPendingStepResult(entry)) {
        checked.push(entry);
        continue;
      }

      let response: LocatorLivenessResponse | null;
      try {
        response = await page.goto(entry.liveUrl, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        checked.push(couldntCheck(entry, `Couldn't open the recorded page directly: ${errorDetail(error)}.`));
        continue;
      }

      if (response === null) {
        checked.push(couldntCheck(entry, "Couldn't check because the direct page visit returned no HTTP response."));
        continue;
      }

      const status = response.status();
      if (status !== 200) {
        checked.push(couldntCheck(entry, `Couldn't check because the page returned HTTP ${status} when opened directly.`));
        continue;
      }

      const authRedirect = await findAuthRedirect(page, entry, plan.auth);
      if (authRedirect !== undefined) {
        checked.push(loginRedirect(entry, authRedirect));
        continue;
      }

      let locator: LocatorLivenessLocator;
      try {
        locator = applyRecordedLocator(page, entry.locator);
      } catch (error) {
        checked.push(couldntCheck(entry, `Couldn't apply the recorded locator: ${errorDetail(error)}.`));
        continue;
      }

      try {
        const count = await locator.count();
        checked.push(count > 0
          ? resolves(entry, count)
          : entry.precedingSubmitStep === undefined
            ? dead(entry)
            : gatedUnreachable(entry));
      } catch (error) {
        checked.push(couldntCheck(entry, `Couldn't count the recorded locator: ${errorDetail(error)}.`));
      }
    }
    return finalizeReport(baseUrl, baseUrlSource, baseUrlFallbackReason, checked);
  } finally {
    try {
      await browser.close();
    } catch {
      // A completed report must not be overwritten by best-effort browser cleanup.
    }
  }
}

/** Plain-English terminal rendering. The first line always identifies the probed base URL. */
export function renderLocatorLivenessReport(report: LocatorLivenessReport): string {
  const { resolves, totalSelectors, dead, gatedUnreachable, couldntCheck, loginRedirect = 0 } = report.summary;
  const hasVisitedRecordedUrl = report.steps.some((step) => step.liveUrl !== undefined);
  const verified = resolves + dead;
  const loginRedirectDetail = loginRedirect === 0 ? '' : `${loginRedirect} login-redirect; `;
  const detail = `${resolves} of ${totalSelectors} selectors still resolve; ${dead} dead; ${gatedUnreachable} gated-unreachable; ${loginRedirectDetail}${couldntCheck} couldn't be checked.`;
  const verdict = locatorLivenessVerdict(report);
  const headline = verdict === 'inconclusive'
    ? `INCONCLUSIVE — preflight verified no selectors; the gate verified nothing. ${detail}`
    : verdict === 'passed'
      ? `PASSED — all ${totalSelectors} selectors still resolve. ${detail}`
      : verdict === 'dead-selectors-found'
        ? `DEAD SELECTORS — preflight verified ${verified} of ${totalSelectors} selectors and found ${dead} dead. ${detail}`
        : `PARTIAL — preflight verified ${verified} of ${totalSelectors} selectors. ${detail}`;
  return [
    `Preflight base URL: ${report.baseUrl} (${baseUrlSourceLabel(report.baseUrlSource)}). ` +
      `Recorded page paths are joined onto this base${hasVisitedRecordedUrl ? '; per-step URLs are in --json' : ''}.`,
    ...(report.baseUrlSource === 'default'
      ? [`WARNING: ${report.baseUrlFallbackReason === 'empty-target-app-url'
        ? 'TARGET_APP_URL was set but empty or whitespace'
        : 'TARGET_APP_URL is unset'}; using default base URL ${report.baseUrl}.`]
      : []),
    headline,
    ...report.steps.map((step) =>
      `  recorded action ${step.recordedAction}: ${step.action} "${displayLabel(step.label)}" | ` +
      `locator: ${displayLocator(step.locator)} | ${step.lane} — ${step.reason}`,
    ),
  ].join('\n');
}

export function locatorLivenessVerdict(report: LocatorLivenessReport): LocatorLivenessVerdict {
  const { resolves, totalSelectors, dead } = report.summary;
  const verified = resolves + dead;
  if (verified === 0) return 'inconclusive';
  if (dead > 0) return 'dead-selectors-found';
  return resolves === totalSelectors ? 'passed' : 'partial';
}

/** The `--json` envelope: the same rows and summary as the terminal report. */
export function locatorLivenessJsonEnvelope(report: LocatorLivenessReport, slug: string): object {
  return {
    slug,
    verdict: locatorLivenessVerdict(report),
    baseUrl: report.baseUrl,
    baseUrlSource: report.baseUrlSource,
    ...(report.baseUrlFallbackReason === undefined ? {} : { baseUrlFallbackReason: report.baseUrlFallbackReason }),
    targetAppUrl: report.targetAppUrl,
    summary: report.summary,
    steps: report.steps,
    ...(report.authRedirect === undefined ? {} : { authRedirect: report.authRedirect }),
  };
}

export function formatLocatorLivenessJson(report: LocatorLivenessReport, slug: string): string {
  return `${JSON.stringify(locatorLivenessJsonEnvelope(report, slug), null, 2)}\n`;
}

interface PendingStepResult extends Omit<LocatorLivenessStepResult, 'lane' | 'reason' | 'gatedBehindStep'> {
  kind: 'pending';
  liveUrl: string;
  precedingSubmitStep?: number;
}

type InitialStepResult = PendingStepResult | LocatorLivenessStepResult;

function initialStepResult(
  step: LocatorLivenessPlanStep,
  recordedAction: number,
  targetAppUrl: string,
  precedingSubmitStep: number | undefined,
): InitialStepResult {
  const base = {
    recordedAction,
    action: step.action,
    label: step.label,
    locator: step.locator,
    ...(step.url === undefined ? {} : { recordedUrl: step.url }),
  };

  if (step.url === undefined || step.url.trim() === '') {
    return {
      ...base,
      lane: "couldn't check",
      reason: "Couldn't check because this sidecar does not record the page for this action.",
    };
  }

  const liveUrl = targetUrlForRecordedPage(step.url, targetAppUrl);
  if (liveUrl.kind === 'invalid') {
    return { ...base, lane: "couldn't check", reason: liveUrl.reason };
  }

  if (step.locator.trim() === '') {
    return {
      ...base,
      liveUrl: liveUrl.value,
      lane: "couldn't check",
      reason: "Couldn't check because no locator was recorded for this action.",
    };
  }

  return {
    ...base,
    kind: 'pending',
    liveUrl: liveUrl.value,
    ...(precedingSubmitStep === undefined ? {} : { precedingSubmitStep }),
  };
}

/**
 * Maps a recorded absolute-or-relative page onto the configured live-app
 * origin. The recording's origin is never used: generated specs also use the
 * recorded pathname against TARGET_APP_URL rather than revisiting production.
 */
export function targetUrlForRecordedPage(
  recordedUrl: string,
  targetAppUrl: string,
): { kind: 'ok'; value: string } | { kind: 'invalid'; reason: string } {
  try {
    const target = new URL(targetAppUrl);
    const recorded = new URL(recordedUrl, target);
    const relativePath = `${recorded.pathname}${recorded.search}${recorded.hash}`;
    return { kind: 'ok', value: new URL(relativePath, target).toString() };
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `Couldn't check because the recorded page or TARGET_APP_URL is not a usable URL: ${errorDetail(error)}.`,
    };
  }
}

/** Applies only the locator grammar this tool emits; never evaluates plan text as JavaScript. */
export function applyRecordedLocator(page: LocatorLivenessPage, locatorSource: string): LocatorLivenessLocator {
  const parsed = parseRecordedLocator(locatorSource);
  switch (parsed.kind) {
    case 'testid':
      return page.getByTestId(parsed.value);
    case 'role':
      return page.getByRole(parsed.role, parsed.name === undefined ? undefined : { name: parsed.name });
    case 'label':
      return page.getByLabel(parsed.value);
    case 'placeholder':
      return page.getByPlaceholder(parsed.value);
    case 'text':
      return page.getByText(parsed.value);
    case 'css': {
      const locator = page.locator(parsed.value);
      return parsed.nth === undefined ? locator : locator.nth(parsed.nth);
    }
  }
}

/** Parses the ready-to-splice locator expressions emitted by `src/selector.ts`. */
export function parseRecordedLocator(locatorSource: string): ParsedLocator {
  const source = locatorSource.trim();
  const simple = (method: string): string | undefined => matchOneString(source, method);

  const testId = simple('getByTestId');
  if (testId !== undefined) return { kind: 'testid', value: testId };
  const label = simple('getByLabel');
  if (label !== undefined) return { kind: 'label', value: label };
  const placeholder = simple('getByPlaceholder');
  if (placeholder !== undefined) return { kind: 'placeholder', value: placeholder };
  const text = simple('getByText');
  if (text !== undefined) return { kind: 'text', value: text };

  const roleMatch = new RegExp(`^getByRole\\(${SINGLE_QUOTED}(?:, \\{ name: ${SINGLE_QUOTED} \\})?\\)$`).exec(source);
  if (roleMatch !== null) {
    return {
      kind: 'role',
      role: decodeSingleQuoted(roleMatch[1]),
      ...(roleMatch[2] === undefined ? {} : { name: decodeSingleQuoted(roleMatch[2]) }),
    };
  }

  const cssMatch = new RegExp(`^locator\\(${SINGLE_QUOTED}\\)(?:\\.nth\\(([0-9]+)\\))?$`).exec(source);
  if (cssMatch !== null) {
    const nth = cssMatch[2] === undefined ? undefined : Number(cssMatch[2]);
    return {
      kind: 'css',
      value: decodeSingleQuoted(cssMatch[1]),
      ...(nth === undefined ? {} : { nth }),
    };
  }

  throw new Error(`unsupported locator expression ${JSON.stringify(locatorSource)}; expected a locator emitted by replaytest`);
}

function matchOneString(source: string, method: string): string | undefined {
  const match = new RegExp(`^${method}\\(${SINGLE_QUOTED}\\)$`).exec(source);
  return match === null ? undefined : decodeSingleQuoted(match[1]);
}

/** Decodes exactly the quote/backslash escaping `selector.ts` emits. */
function decodeSingleQuoted(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) throw new Error('unterminated escape in locator string');
    if (escaped !== '\\' && escaped !== "'") {
      throw new Error(`unsupported escape \\${escaped} in locator string`);
    }
    decoded += escaped;
    index += 1;
  }
  return decoded;
}

function resolves(entry: PendingStepResult, count: number): LocatorLivenessStepResult {
  return {
    ...withoutKind(entry),
    lane: 'resolves',
    count,
    reason: count === 1
      ? '1 matching element on a page that returned HTTP 200.'
      : `${count} matching elements on a page that returned HTTP 200 (more than one resolves).`,
  };
}

/**
 * Auth is a first-load observation only. A later page can legitimately contain
 * a password field, and a direct load that did not change URL is not evidence
 * of a redirect. The weak password corroboration is retained as an observation
 * rather than a claim that the application requires authentication.
 */
async function findAuthRedirect(
  page: LocatorLivenessPage,
  entry: PendingStepResult,
  auth: LocatorLivenessAuth | undefined,
): Promise<LocatorLivenessAuthRedirect | undefined> {
  if (entry.recordedAction !== 1) return undefined;

  let requested: URL;
  let landed: URL;
  try {
    requested = new URL(entry.liveUrl);
    landed = new URL(page.url());
  } catch {
    return undefined;
  }
  if (requested.href === landed.href) return undefined;

  const matchesWitnessedLoginPath = auth !== undefined && landed.pathname === normalizedPath(auth.loginPath);
  let passwordInputPresent = false;
  try {
    passwordInputPresent = (await page.locator('input[type=password]').count()) > 0;
  } catch {
    // The selector-count failure belongs to the ordinary recorded locator
    // check; it must not manufacture an auth finding.
  }
  if (!matchesWitnessedLoginPath && !passwordInputPresent) return undefined;

  return {
    recordedAction: entry.recordedAction,
    requestedPath: requested.pathname,
    landedPath: landed.pathname,
    matchesWitnessedLoginPath,
    passwordInputPresent,
  };
}

function normalizedPath(value: string): string {
  try {
    return new URL(value, 'http://replaytest.invalid').pathname;
  } catch {
    return value;
  }
}

function dead(entry: PendingStepResult): LocatorLivenessStepResult {
  return {
    ...withoutKind(entry),
    lane: 'DEAD',
    count: 0,
    reason: 'Page loaded directly (HTTP 200), but the locator matched no elements.',
  };
}

function loginRedirect(entry: PendingStepResult, authRedirect: LocatorLivenessAuthRedirect): LocatorLivenessStepResult {
  const observation = authRedirect.matchesWitnessedLoginPath
    ? `landed pathname matching the login path witnessed in this plan's recording (${authRedirect.landedPath})`
    : `landed page contains an input[type=password] (${authRedirect.landedPath})`;
  return {
    ...withoutKind(entry),
    lane: 'login-redirect',
    authRedirect,
    reason: `The direct page visit redirected from ${authRedirect.requestedPath} to ${authRedirect.landedPath}; ${observation}. The recorded locator for this step was not checked, so it is reported as neither resolved nor dead. Run auth-setup or set TARGET_APP_STORAGE_STATE.`,
  };
}

function gatedUnreachable(entry: PendingStepResult): LocatorLivenessStepResult {
  const gatedBehindStep = entry.precedingSubmitStep;
  if (gatedBehindStep === undefined) return dead(entry);
  return {
    ...withoutKind(entry),
    lane: 'gated-unreachable',
    count: 0,
    gatedBehindStep,
    reason: `An earlier recorded submit (recorded action ${gatedBehindStep}) means a direct load may not reach this state; couldn't check without interaction — run the full spec to verify.`,
  };
}

function couldntCheck(entry: PendingStepResult, reason: string): LocatorLivenessStepResult {
  return { ...withoutKind(entry), lane: "couldn't check", reason };
}

function withoutKind(entry: PendingStepResult): Omit<PendingStepResult, 'kind' | 'precedingSubmitStep'> {
  const { kind: _kind, precedingSubmitStep: _precedingSubmitStep, ...result } = entry;
  return result;
}

function isPendingStepResult(entry: InitialStepResult): entry is PendingStepResult {
  return 'kind' in entry && entry.kind === 'pending';
}

function finalizeReport(
  baseUrl: string,
  baseUrlSource: LocatorLivenessBaseUrlSource,
  baseUrlFallbackReason: LocatorLivenessBaseUrlFallbackReason | undefined,
  steps: readonly InitialStepResult[],
): LocatorLivenessReport {
  const completedSteps = steps.map((step) => {
    if (isPendingStepResult(step)) {
      return couldntCheck(step, 'Couldn\'t check because the local browser preflight did not complete.');
    }
    return step;
  });
  const summary = completedSteps.reduce<LocatorLivenessSummary>(
    (totals, step) => ({
      totalSelectors: totals.totalSelectors + 1,
      resolves: totals.resolves + (step.lane === 'resolves' ? 1 : 0),
      dead: totals.dead + (step.lane === 'DEAD' ? 1 : 0),
      gatedUnreachable: totals.gatedUnreachable + (step.lane === 'gated-unreachable' ? 1 : 0),
      couldntCheck: totals.couldntCheck + (step.lane === "couldn't check" ? 1 : 0),
      ...(step.lane === 'login-redirect' ? { loginRedirect: (totals.loginRedirect ?? 0) + 1 } : {}),
    }),
    { totalSelectors: 0, resolves: 0, dead: 0, gatedUnreachable: 0, couldntCheck: 0 } satisfies LocatorLivenessSummary,
  );
  const authRedirect = completedSteps.find((step) => step.authRedirect !== undefined)?.authRedirect;
  return {
    baseUrl,
    baseUrlSource,
    ...(baseUrlFallbackReason === undefined ? {} : { baseUrlFallbackReason }),
    targetAppUrl: baseUrl,
    summary,
    steps: completedSteps,
    ...(authRedirect === undefined ? {} : { authRedirect }),
  };
}

function resolveBaseUrl(options: LocatorLivenessOptions): {
  baseUrl: string;
  baseUrlSource: LocatorLivenessBaseUrlSource;
  baseUrlFallbackReason?: LocatorLivenessBaseUrlFallbackReason;
} {
  if (options.targetAppUrl !== undefined) {
    return { baseUrl: options.targetAppUrl, baseUrlSource: 'option' };
  }
  const targetAppUrl = process.env.TARGET_APP_URL;
  if (targetAppUrl !== undefined && targetAppUrl.trim() !== '') {
    return { baseUrl: targetAppUrl, baseUrlSource: 'env' };
  }
  return {
    baseUrl: DEFAULT_TARGET_APP_URL,
    baseUrlSource: 'default',
    baseUrlFallbackReason: targetAppUrl === undefined ? 'unset' : 'empty-target-app-url',
  };
}

function baseUrlSourceLabel(source: LocatorLivenessBaseUrlSource): string {
  switch (source) {
    case 'option':
      return 'option';
    case 'env':
      return 'TARGET_APP_URL';
    case 'default':
      return 'default';
  }
}

function displayLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unlabeled';
}

function displayLocator(locator: string): string {
  return locator === '' ? '(no recorded locator)' : locator;
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown error';
}

async function launchLocalBrowser(): Promise<LocatorLivenessBrowser> {
  const { chromium } = await import('@playwright/test');
  return chromium.launch({ headless: true });
}
