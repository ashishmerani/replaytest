import * as fs from 'node:fs';
import * as path from 'node:path';
import { emitArtifact, type ArtifactPrivacyOptions } from '../../artifact-registry.js';
import { buildPrivacyDisclosure, PRIVACY_DISCLOSURE_REQUIRED_COPY } from '../../pii-lint.js';
import type { Sidecar, SidecarStep } from '../../sidecar.js';
import { parseSidecarJson } from '../../triage.js';
import { buildUsageError, parseAuthSetupArgs } from '../args.js';
import { maybePrintVerbHelp } from '../help.js';
import { AUTH_SETUP_PATH, AUTH_STORAGE_STATE_PATH, WORKSPACE_ROOT } from '../paths.js';

/** One exact marker shared with the packaged repair skill so an agent has one grep target. */
export const AUTH_SOCKET_MARKER = 'auth-socket:';

export interface AuthSetupPlanWitness {
  slug: string;
  title: string;
  loginPath: string;
  shape: NonNullable<Sidecar['auth']>['shape'];
  sessionId: string;
  specPath: string;
  sidecar: Sidecar;
}

export interface AuthSetupPathGroup {
  loginPath: string;
  plans: AuthSetupPlanWitness[];
}

export type AuthSetupConfigKind = 'none' | 'readme-minimal' | 'hand-authored';

export interface AuthSetupConfigInfo {
  kind: AuthSetupConfigKind;
  configPath?: string;
  hasBaseUrl: boolean;
  snippet: string;
  note: string;
}

export interface AuthSetupRunDeps {
  workspaceRoot?: string;
  plansDir?: string;
  authSetupPath?: string;
  storageStatePath?: string;
  readDirectory?: (directory: string) => string[];
  pathExists?: (filename: string) => boolean;
  readFile?: (filename: string) => string;
  writeFile?: (filename: string, content: string, options?: ArtifactPrivacyOptions) => void;
  log?: (line: string) => void;
}

interface ResolvedAuthSetupDeps {
  workspaceRoot: string;
  plansDir: string;
  authSetupPath: string;
  storageStatePath: string;
  readDirectory: (directory: string) => string[];
  pathExists: (filename: string) => boolean;
  readFile: (filename: string) => string;
  writeFile: (filename: string, content: string, options?: ArtifactPrivacyOptions) => void;
  log: (line: string) => void;
}

const PLAYWRIGHT_CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
] as const;

/** The exact refusal copy is a safety contract: auth.setup.ts may contain hand-finished sign-in steps. */
export function buildAuthSetupExistsRefusal(): string {
  return 'auth.setup.ts already exists — refusing to overwrite (it may hold hand-finished sign-in steps). To regenerate, delete the file and re-run auth-setup.';
}

export function buildAuthSetupZeroWitnessMessage(): string {
  return 'No persisted plan sidecars witnessed a login — auth-setup wrote nothing.';
}

export function buildAuthSetupMultiPathRefusal(loginPaths: readonly string[]): string {
  return `auth-setup refuses to choose among ${loginPaths.length} distinct witnessed login paths. Hand this grouped table to your agent.`;
}

function resolveDeps(deps: AuthSetupRunDeps): ResolvedAuthSetupDeps {
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const authSetupPath = deps.authSetupPath ?? path.join(workspaceRoot, AUTH_SETUP_PATH);
  const writeFile = deps.writeFile ?? ((filename: string, content: string, options?: ArtifactPrivacyOptions) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    emitArtifact('auth-setup', filename, content, options);
  });
  return {
    workspaceRoot,
    plansDir: deps.plansDir ?? path.join(workspaceRoot, '.replaytest', 'plans'),
    authSetupPath,
    storageStatePath: deps.storageStatePath ?? AUTH_STORAGE_STATE_PATH,
    readDirectory: deps.readDirectory ?? ((directory) => fs.readdirSync(directory)),
    pathExists: deps.pathExists ?? fs.existsSync,
    readFile: deps.readFile ?? ((filename) => fs.readFileSync(filename, 'utf8')),
    writeFile,
    log: deps.log ?? ((line) => console.log(line)),
  };
}

/** Reads only persisted plan sidecars. A malformed sidecar is disclosed and cannot silently become a missing witness. */
export function collectAuthSetupWitnesses(
  plansDir: string,
  readDirectory: (directory: string) => string[],
  readFile: (filename: string) => string,
  workspaceRoot: string,
  disclose: (line: string) => void = () => undefined,
): AuthSetupPlanWitness[] {
  let filenames: string[];
  try {
    filenames = readDirectory(plansDir)
  } catch (error) {
    disclose(`Could not read ${displayPath(workspaceRoot, plansDir)}: ${errorDetail(error)}.`);
    return [];
  }

  const witnesses: AuthSetupPlanWitness[] = [];
  for (const filename of filenames.filter((candidate) => candidate.endsWith('.plan.json') && !candidate.endsWith('.proposed.plan.json')).sort()) {
    const filePath = path.join(plansDir, filename);
    let raw: string;
    try {
      raw = readFile(filePath);
    } catch (error) {
      disclose(`Skipped ${displayPath(workspaceRoot, filePath)}: could not read it (${errorDetail(error)}).`);
      continue;
    }
    const parsed = parseSidecarJson(raw);
    if (parsed.kind === 'invalid') {
      disclose(`Skipped ${displayPath(workspaceRoot, filePath)}: invalid sidecar (${parsed.reason}).`);
      continue;
    }
    const auth = parsed.sidecar.auth;
    if (auth === undefined) continue;
    const slug = filename.slice(0, -'.plan.json'.length);
    witnesses.push({
      slug,
      title: parsed.sidecar.title,
      loginPath: pathnameOnly(auth.loginPath),
      shape: auth.shape,
      sessionId: parsed.sidecar.source.sessionId,
      specPath: path.join('tests', 'generated', `${slug}.spec.ts`),
      sidecar: parsed.sidecar,
    });
  }
  return witnesses;
}

export function groupAuthSetupWitnesses(witnesses: readonly AuthSetupPlanWitness[]): AuthSetupPathGroup[] {
  const groups = new Map<string, AuthSetupPlanWitness[]>();
  for (const witness of witnesses) {
    const current = groups.get(witness.loginPath) ?? [];
    current.push(witness);
    groups.set(witness.loginPath, current);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([loginPath, plans]) => ({
      loginPath,
      plans: [...plans].sort((left, right) => left.slug.localeCompare(right.slug)),
    }));
}

export function renderAuthSetupWhoNeedsTable(groups: readonly AuthSetupPathGroup[]): string[] {
  const lines = [
    'Who needs auth setup (from persisted plan sidecars):',
    '| loginPath | plan / generated spec | witnessed shape |',
    '|---|---|---|',
  ];
  if (groups.length === 0) {
    lines.push('| (none) | (none) | (none) |');
  } else {
    for (const group of groups) {
      for (const plan of group.plans) {
        lines.push(`| ${group.loginPath} | ${plan.slug} / ${plan.specPath} | ${plan.shape} |`);
      }
    }
  }
  lines.push(
    'Not listed: journeys before a witnessed login and sessions with no witnessed login. They may still be auth-gated; the recording simply did not witness it.',
  );
  return lines;
}

export function renderAuthSetupSkeleton(
  group: AuthSetupPathGroup,
  storageStatePath = AUTH_STORAGE_STATE_PATH,
): string {
  const source = group.plans.find((plan) => plan.shape === 'contains-login' && authSetupEmissionRange(plan.sidecar.steps) !== undefined);
  const loginSteps = source === undefined ? [] : authSetupEmissionRange(source.sidecar.steps)?.steps ?? [];
  const lines = [
    '// Generated by replaytest auth-setup from persisted witnessed login data.',
    `// Witnessed loginPath: ${group.loginPath} (pathname only; the recorded origin is intentionally omitted).`,
    `// ${AUTH_SOCKET_MARKER} Fill the environment-variable sockets below with safe test credentials in your workspace.`,
    `// WARNING: do not run this setup until the sockets are filled; an empty storageState silently saves an unauthenticated state.`,
    `// If the state expires, Playwright will fail at runtime; delete this file and re-run auth-setup to regenerate it.`,
    '',
    "import { test as setup } from '@playwright/test';",
    '',
    `const authFile = ${singleQuoted(storageStatePath)};`,
    '',
    "setup('authenticate', async ({ page }) => {",
    `  await page.goto(${singleQuoted(group.loginPath)});`,
  ];

  if (loginSteps.length === 0) {
    lines.push(`  // ${AUTH_SOCKET_MARKER} Add the customer's real sign-in steps here; use environment variables, never recorded values.`);
  } else {
    for (const [index, step] of loginSteps.entries()) lines.push(...renderAuthSocketStep(step, index));
  }

  lines.push(
    '',
    '  await page.context().storageState({ path: authFile });',
    '});',
    '',
  );
  return lines.join('\n');
}

function renderAuthSocketStep(step: SidecarStep, index: number): string[] {
  const indent = '  ';
  if (step.locator.trim() === '') {
    return [`${indent}// ${AUTH_SOCKET_MARKER} TODO: resolve the witnessed ${step.action} "${safeLabel(step.label)}" selector in the customer app.`];
  }
  const locator = `page.${step.locator}`;
  if (step.action === 'fill') {
    const envName = authEnvName(step, index);
    return [
      `${indent}// ${AUTH_SOCKET_MARKER} ${envName} supplies the value for witnessed "${safeLabel(step.label)}".`,
      `${indent}await ${locator}.fill(process.env.${envName} ?? '');`,
    ];
  }
  if (step.action === 'press') return [`${indent}// ${AUTH_SOCKET_MARKER} witnessed commit mechanic; verify this key in the customer app.`, `${indent}await ${locator}.press(${JSON.stringify(step.pressKey ?? 'Enter')});`];
  return [`${indent}await ${locator}.click();`];
}

function authEnvName(step: SidecarStep, index: number): string {
  if (step.inputType === 'password') return 'REPLAYTEST_AUTH_PASSWORD';
  const label = step.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `REPLAYTEST_AUTH_${label || `FIELD_${index + 1}`}`;
}

interface AuthSetupEmissionRange {
  start: number;
  end: number;
  steps: SidecarStep[];
}

/**
 * Derived at render time for emission: every witnessed step from the first
 * login-page fill through the first witnessed submit after it. This is an
 * emission range, not a prose-only login naming range; the persisted sidecar
 * stores no range claim.
 */
function authSetupEmissionRange(steps: readonly SidecarStep[]): AuthSetupEmissionRange | undefined {
  const start = steps.findIndex((step) => step.action === 'fill');
  if (start === -1) return undefined;
  const end = steps.findIndex((step, index) => index >= start && step.isSubmit === true);
  if (end === -1) return undefined;
  return { start, end, steps: steps.slice(start, end + 1) };
}

/** Reads the customer's config only to select one of the three print-only snippet shapes. */
export function inspectAuthSetupConfig(
  workspaceRoot: string,
  pathExists: (filename: string) => boolean,
  readFile: (filename: string) => string,
  storageStatePath = AUTH_STORAGE_STATE_PATH,
): AuthSetupConfigInfo {
  const config = PLAYWRIGHT_CONFIG_NAMES
    .map((name) => ({ name, filename: path.join(workspaceRoot, name) }))
    .find((candidate) => pathExists(candidate.filename));
  if (config === undefined) {
    return {
      kind: 'none',
      hasBaseUrl: true,
      snippet: minimalPlaywrightConfig(storageStatePath),
      note: 'baseURL: included in this minimal config via TARGET_APP_URL || http://localhost:8000.',
    };
  }

  const source = readFile(config.filename);
  const hasBaseUrl = /\bbaseURL\s*:/.test(source);
  const consumesStorageStateEnv = source.includes('TARGET_APP_STORAGE_STATE');
  const projectNames = [...source.matchAll(/\bname\s*:\s*["'][^"']+["']/g)];
  const isReadmeMinimal = consumesStorageStateEnv && hasBaseUrl && projectNames.length <= 1;
  if (isReadmeMinimal) {
    return {
      kind: 'readme-minimal',
      configPath: path.relative(workspaceRoot, config.filename),
      hasBaseUrl,
      snippet: readmeMinimalProjectsInsertion(),
      note: `baseURL: confirmed in ${path.relative(workspaceRoot, config.filename)}. TARGET_APP_STORAGE_STATE already consumes ${storageStatePath}; do not duplicate a storageState line.`,
    };
  }
  return {
    kind: 'hand-authored',
    configPath: path.relative(workspaceRoot, config.filename),
    hasBaseUrl,
    snippet: handAuthoredSetupBlock(storageStatePath),
    note: hasBaseUrl
      ? `baseURL: confirmed in ${path.relative(workspaceRoot, config.filename)}. We cannot determine which of your projects should depend on setup; the skill-side agent selects them from the who-needs-it table.`
      : `baseURL: not found in ${path.relative(workspaceRoot, config.filename)}; confirm it before using pathname-only page.goto(). We cannot determine which of your projects should depend on setup; the skill-side agent selects them from the who-needs-it table.`,
  };
}

// Emitted config snippets are single-quoted throughout via the shared singleQuoted
// helper below; JSON.stringify's double quotes were the sole exception before the
// quote-style cleanup.
function minimalPlaywrightConfig(storageStatePath: string): string {
  return [
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: './tests',",
    '  use: {',
    "    baseURL: process.env.TARGET_APP_URL || 'http://localhost:8000',",
    `    storageState: ${singleQuoted(storageStatePath)},`,
    '  },',
    '  projects: [',
    "    { name: 'setup', testMatch: /auth.setup.ts/ },",
    "    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },",
    '  ],',
    '});',
  ].join('\n');
}

function readmeMinimalProjectsInsertion(): string {
  return [
    'projects: [',
    "  { name: 'setup', testMatch: /auth.setup.ts/ },",
    "  // Add dependencies: ['setup'] to the project(s) that run auth-witnessed specs.",
    '],',
  ].join('\n');
}

function handAuthoredSetupBlock(storageStatePath: string): string {
  return [
    'projects: [',
    "  { name: 'setup', testMatch: /auth.setup.ts/ },",
    '],',
    '',
    `// For the project(s) selected by the agent, add dependencies: ['setup'] and use: { storageState: ${singleQuoted(storageStatePath)} }.`,
  ].join('\n');
}

/** `auth-setup` is intentionally human-readable; v1 has no `--json` serializer. */
export function runAuthSetup(argv: string[], deps: AuthSetupRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'auth-setup', deps.log)) return;
  const resolved = resolveDeps(deps);
  const args = parseAuthSetupArgs(argv);
  if (argv.some((arg) => !arg.startsWith('--'))) {
    resolved.log(buildUsageError('auth-setup'));
    process.exitCode = 1;
    return;
  }
  if (args.json) {
    resolved.log('auth-setup does not support --json in v1; read the skeleton, who-needs-it table, and printed config snippet instead.');
    process.exitCode = 1;
    return;
  }

  const witnesses = collectAuthSetupWitnesses(
    resolved.plansDir,
    resolved.readDirectory,
    resolved.readFile,
    resolved.workspaceRoot,
    resolved.log,
  );
  const groups = groupAuthSetupWitnesses(witnesses);
  for (const line of renderAuthSetupWhoNeedsTable(groups)) resolved.log(line);

  if (groups.length === 0) {
    resolved.log(buildAuthSetupZeroWitnessMessage());
    return;
  }
  if (groups.length >= 2) {
    resolved.log(buildAuthSetupMultiPathRefusal(groups.map((group) => group.loginPath)));
    process.exitCode = 1;
    return;
  }
  if (resolved.pathExists(resolved.authSetupPath)) {
    resolved.log(buildAuthSetupExistsRefusal());
    process.exitCode = 1;
    return;
  }

  const group = groups[0];
  const privacyDisclosure = buildPrivacyDisclosure(group.plans.flatMap((witness) => [
    { path: 'AuthSetupPlanWitness.loginPath', value: witness.loginPath },
    { path: 'AuthSetupPlanWitness.title', value: witness.title },
    { path: 'AuthSetupPlanWitness.sidecar.source.distinctId', value: witness.sidecar.source.distinctId, kinds: ['email', 'provider-token'] as const },
    { path: 'AuthSetupPlanWitness.sidecar.start', value: witness.sidecar.start },
    ...witness.sidecar.steps.flatMap((step) => step.action === 'press' ? [] : [
      { path: 'AuthSetupPlanWitness.sidecar.steps[].label', value: step.label },
      ...(step.locator === '' ? [] : [{ path: 'AuthSetupPlanWitness.sidecar.steps[].locator', value: step.locator }]),
    ]),
  ]));
  if (privacyDisclosure !== undefined && args.allowPrivacyDisclosure !== true) {
    resolved.log(PRIVACY_DISCLOSURE_REQUIRED_COPY);
    process.exitCode = 1;
    return;
  }
  resolved.writeFile(resolved.authSetupPath, renderAuthSetupSkeleton(group, resolved.storageStatePath), {
    privacyDisclosure,
    allowPrivacyDisclosure: args.allowPrivacyDisclosure === true,
  });
  resolved.log(`Wrote ${displayPath(resolved.workspaceRoot, resolved.authSetupPath)}`);

  const config = inspectAuthSetupConfig(resolved.workspaceRoot, resolved.pathExists, resolved.readFile, resolved.storageStatePath);
  resolved.log('');
  resolved.log('Config wiring (printed only; auth-setup did not edit your config file):');
  if (config.configPath !== undefined) resolved.log(`Config case: ${config.kind} (${config.configPath}).`);
  else resolved.log('Config case: no Playwright config found.');
  resolved.log(config.note);
  resolved.log(config.snippet);
}

function pathnameOnly(value: string): string {
  try {
    return new URL(value, 'http://replaytest.invalid').pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] || '/';
  }
}

function displayPath(workspaceRoot: string, filename: string): string {
  const relative = path.relative(workspaceRoot, filename);
  return relative === '' ? path.basename(filename) : relative;
}

function safeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unlabeled control';
}

function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').trim() || 'unknown error';
}
