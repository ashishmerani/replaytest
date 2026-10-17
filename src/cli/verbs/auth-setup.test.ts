import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  AUTH_SOCKET_MARKER,
  buildAuthSetupExistsRefusal,
  buildAuthSetupMultiPathRefusal,
  buildAuthSetupZeroWitnessMessage,
  inspectAuthSetupConfig,
  renderAuthSetupSkeleton,
  runAuthSetup,
  type AuthSetupPathGroup,
} from '../../cli.js';
import { buildVerbHelpText, parseAuthSetupArgs } from '../../cli.js';

const originalExitCode = process.exitCode;

test.after(() => {
  process.exitCode = originalExitCode;
});

function sidecarJson(options: { loginPath?: string; shape?: 'contains-login' | 'after-login'; slug?: string; auth?: boolean; distinctId?: string } = {}): string {
  const slug = options.slug ?? 'account';
  const loginPath = options.loginPath ?? '/login';
  const shape = options.shape ?? 'contains-login';
  const includeAuth = options.auth ?? true;
  return JSON.stringify({
    version: 1,
    title: 'Account',
    source: {
      distinctId: options.distinctId ?? 'user-1',
      sessionId: `${slug}-session`,
      journeyIndex: 0,
      generatedAt: '2026-08-22T00:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: shape === 'contains-login' ? loginPath : '/account',
    ...(includeAuth ? { auth: { witnessed: true, loginPath, shape } } : {}),
    steps: shape === 'contains-login'
      ? [
          { action: 'fill', label: 'Email', locator: "getByLabel('Email')", url: loginPath, inputType: 'email' },
          { action: 'fill', label: 'Password', locator: "getByLabel('Password')", url: loginPath, inputType: 'password' },
          { action: 'click', label: 'Sign in', locator: "getByRole('button', { name: 'Sign in' })", url: loginPath, isSubmit: true },
        ]
      : [{ action: 'click', label: 'Account', locator: "getByRole('link', { name: 'Account' })", url: '/account' }],
    assertions: [],
  }, null, 2);
}

const containsLoginGroup: AuthSetupPathGroup = {
  loginPath: '/login',
  plans: [{
    slug: 'account',
    title: 'Account',
    loginPath: '/login',
    shape: 'contains-login',
    sessionId: 'account-session',
    specPath: 'tests/generated/account.spec.ts',
    sidecar: JSON.parse(sidecarJson()) as never,
  }],
};

test('auth-setup renders a pathname-only skeleton from witnessed selectors and env sockets', () => {
  const skeleton = renderAuthSetupSkeleton(containsLoginGroup);
  assert.ok(skeleton.includes("await page.goto('/login');"));
  assert.doesNotMatch(skeleton, /https?:\/\//);
  assert.ok(skeleton.includes("await page.getByLabel('Email').fill(process.env.REPLAYTEST_AUTH_EMAIL ?? '');"));
  assert.ok(skeleton.includes("await page.getByLabel('Password').fill(process.env.REPLAYTEST_AUTH_PASSWORD ?? '');"));
  assert.ok(skeleton.includes("await page.getByRole('button', { name: 'Sign in' }).click();"));
  assert.equal([...skeleton.matchAll(new RegExp(`^  \/\/ ${AUTH_SOCKET_MARKER} REPLAYTEST_AUTH_[A-Z0-9_]+ supplies`, 'gm'))].length, 2);
  assert.ok(skeleton.includes(`// ${AUTH_SOCKET_MARKER}`));
  assert.ok(skeleton.includes('empty storageState silently saves an unauthenticated state'));
  assert.ok(skeleton.includes("await page.context().storageState({ path: authFile });"));
  assert.doesNotMatch(skeleton, /4242|secret|masked|user-1|account-session/);
  assert.ok(readFileSync(new URL('../../../skills/replaytest-repair/SKILL.md', import.meta.url), 'utf8').includes(AUTH_SOCKET_MARKER));
});

test('runAuthSetup scans persisted sidecars, writes one skeleton, and prints the grouped table plus config snippet', () => {
  const output: string[] = [];
  let written: { filename: string; content: string } | undefined;
  const fullLoginPath = 'https://recorded-origin.example.com/login.html?next=%2Fhome#top';
  runAuthSetup([], {
    workspaceRoot: '/workspace',
    plansDir: '/workspace/.replaytest/plans',
    readDirectory: () => ['account.plan.json', 'no-auth.plan.json'],
    pathExists: () => false,
    readFile: (filename) => filename.endsWith('account.plan.json') ? sidecarJson({ loginPath: fullLoginPath }) : sidecarJson({ shape: 'after-login', auth: false }),
    writeFile: (filename, content) => { written = { filename, content }; },
    log: (line) => output.push(line),
  });

  assert.equal(written?.filename, '/workspace/playwright/auth.setup.ts');
  assert.ok(written?.content.includes("await page.goto('/login.html');"));
  assert.doesNotMatch(written?.content ?? '', /recorded-origin|next=|#top/);
  assert.ok(output.some((line) => line.includes('| /login.html | account / tests/generated/account.spec.ts | contains-login |')));
  assert.ok(output.some((line) => line.includes('Not listed: journeys before a witnessed login')));
  assert.ok(output.some((line) => line.includes('Config case: no Playwright config found.')));
  assert.ok(output.some((line) => line.includes('baseURL: included in this minimal config')));
  assert.ok(output.some((line) => line.includes('storageState')));
});

test('runAuthSetup blocks a PII-shaped witnessed login carrier before writing, with an explicit override', () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output: string[] = [];
    let writes = 0;
    const piiSidecar = sidecarJson().replace('"user-1"', '"priya@example.com"');
    const deps = {
      workspaceRoot: '/workspace',
      plansDir: '/workspace/.replaytest/plans',
      readDirectory: () => ['account.plan.json'],
      pathExists: () => false,
      readFile: () => piiSidecar,
      writeFile: () => { writes += 1; },
      log: (line: string) => output.push(line),
    };
    runAuthSetup([], deps);
    assert.equal(writes, 0);
    assert.equal(process.exitCode, 1);
    assert.ok(output.some((line) => line.startsWith('privacy-disclosure-required:')));

    process.exitCode = undefined;
    runAuthSetup(['--allow-privacy-disclosure'], deps);
    assert.equal(writes, 1);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runAuthSetup screens the one group it will write, including provider-token-shaped sidecar identity', () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output: string[] = [];
    let writes = 0;
    const tokenSidecar = sidecarJson({ distinctId: `phc_${'a'.repeat(30)}` });
    runAuthSetup([], {
      workspaceRoot: '/workspace',
      plansDir: '/workspace/.replaytest/plans',
      readDirectory: () => ['account.plan.json'],
      pathExists: () => false,
      readFile: () => tokenSidecar,
      writeFile: () => { writes += 1; },
      log: (line) => output.push(line),
    });
    assert.equal(writes, 0);
    assert.equal(process.exitCode, 1);
    assert.ok(output.some((line) => line.startsWith('privacy-disclosure-required:')));
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('auth-setup refuses to overwrite and refuses multiple distinct login paths', () => {
  assert.equal(
    buildAuthSetupExistsRefusal(),
    'auth.setup.ts already exists — refusing to overwrite (it may hold hand-finished sign-in steps). To regenerate, delete the file and re-run auth-setup.',
  );
  const output: string[] = [];
  let writes = 0;
  const files: Record<string, string> = {
    '/workspace/.replaytest/plans/a.plan.json': sidecarJson({ slug: 'a', loginPath: '/login' }),
    '/workspace/.replaytest/plans/b.plan.json': sidecarJson({ slug: 'b', loginPath: '/admin/login' }),
    '/workspace/.replaytest/plans/proposal.proposed.plan.json': sidecarJson({ slug: 'proposal', loginPath: '/proposal-login' }),
  };
  const readFilenames: string[] = [];
  runAuthSetup([], {
    workspaceRoot: '/workspace',
    plansDir: '/workspace/.replaytest/plans',
    readDirectory: () => ['a.plan.json', 'b.plan.json', 'proposal.proposed.plan.json'],
    pathExists: () => false,
    readFile: (filename) => { readFilenames.push(filename); return files[filename]!; },
    writeFile: () => { writes += 1; },
    log: (line) => output.push(line),
  });
  assert.equal(writes, 0);
  assert.equal(readFilenames.some((filename) => filename.endsWith('proposal.proposed.plan.json')), false);
  assert.ok(output.some((line) => line.includes('| /admin/login |')));
  assert.ok(output.some((line) => line.includes('refuses to choose among 2 distinct witnessed login paths')));
  assert.equal(buildAuthSetupMultiPathRefusal(['/admin/login', '/login']).includes('Hand this grouped table to your agent'), true);

  const existingOutput: string[] = [];
  let existingWrites = 0;
  runAuthSetup([], {
    workspaceRoot: '/workspace',
    plansDir: '/workspace/.replaytest/plans',
    readDirectory: () => ['account.plan.json'],
    pathExists: (filename) => filename === '/workspace/playwright/auth.setup.ts',
    readFile: () => sidecarJson(),
    writeFile: () => { existingWrites += 1; },
    log: (line) => existingOutput.push(line),
  });
  assert.equal(existingWrites, 0);
  assert.ok(existingOutput.includes(buildAuthSetupExistsRefusal()));
});

test('auth-setup zero-witness path writes nothing and says what the recording did not show', () => {
  const output: string[] = [];
  let writes = 0;
  runAuthSetup([], {
    plansDir: '/workspace/.replaytest/plans',
    readDirectory: () => [],
    pathExists: () => false,
    writeFile: () => { writes += 1; },
    log: (line) => output.push(line),
  });
  assert.equal(writes, 0);
  assert.ok(output.includes(buildAuthSetupZeroWitnessMessage()));
});

test('auth-setup config inspection prints the three insertable cases without a unified diff', () => {
  const none = inspectAuthSetupConfig('/workspace', () => false, () => { throw new Error('not read'); });
  assert.equal(none.kind, 'none');
  assert.ok(none.snippet.includes("{ name: 'setup', testMatch: /auth.setup.ts/ }"));
  assert.ok(none.snippet.includes('storageState'));
  assert.ok(none.note.includes('baseURL: included'));

  const minimal = inspectAuthSetupConfig('/workspace', (filename: string) => filename.endsWith('playwright.config.ts'), () => [
    "baseURL: process.env.TARGET_APP_URL || 'http://localhost:8000',",
    "...(process.env.TARGET_APP_STORAGE_STATE ? { storageState: process.env.TARGET_APP_STORAGE_STATE } : {}),",
    "projects: [{ name: 'chromium' }],",
  ].join('\n'));
  assert.equal(minimal.kind, 'readme-minimal');
  assert.ok(!minimal.snippet.includes('storageState:'));
  assert.ok(minimal.note.includes('do not duplicate a storageState line'));

  const handAuthored = inspectAuthSetupConfig('/workspace', (filename: string) => filename.endsWith('playwright.config.ts'), () => [
    "baseURL: 'http://localhost:8000',",
    "projects: [{ name: 'chromium' }, { name: 'chromium-acme' }],",
  ].join('\n'));
  assert.equal(handAuthored.kind, 'hand-authored');
  assert.ok(handAuthored.snippet.includes("{ name: 'setup', testMatch: /auth.setup.ts/ }"));
  assert.ok(handAuthored.note.includes('baseURL: confirmed'));
  assert.ok(handAuthored.note.includes('cannot determine which of your projects should depend on setup'));
});

test('auth-setup help and parser deliberately omit a JSON surface', () => {
  assert.equal(parseAuthSetupArgs([]).json, false);
  assert.equal(parseAuthSetupArgs(['--json']).json, true);
  const help = buildVerbHelpText('auth-setup');
  assert.ok(help.includes('auth-setup'));
  assert.doesNotMatch(help, /\[--json\]/);
});

test('auth-setup refuses its deferred JSON surface before reading plans', () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output: string[] = [];
    let read = false;
    runAuthSetup(['--json'], {
      readDirectory: () => { read = true; return []; },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(read, false);
    assert.ok(output.some((line) => line.includes('auth-setup does not support --json in v1')));
  } finally {
    process.exitCode = originalExitCode;
  }
});
