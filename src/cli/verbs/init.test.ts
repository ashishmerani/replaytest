import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildInitNextStepHint, buildInitSetupHint, buildGitignoreEnvGuard, formatConfigStatus, formatInitConfigWriteStatus, hasAnyConfig } from '../../cli.js';
import { runCliInFixture } from './test-support.js';

const initReadOnlySkip = typeof process.getuid === 'function' && process.getuid() === 0
  ? 'requires a non-root user: read-only fixture permissions do not block root writes'
  : false;

function assertStacklessInitRefusal(result: ReturnType<typeof runCliInFixture>): string {
  assert.equal(result.status, 1);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(combined, /(?:^|\n)Error:/);
  assert.doesNotMatch(combined, /\n\s+at\s+/);
  return combined;
}

test('formatInitConfigWriteStatus: first writes are not labeled as updates, while existing files retain changed-field markers', () => {
  const status = { projectId: '12345', hasApiKey: true, host: 'eu.posthog.com' };
  const writtenFields = { project: true, token: true, host: true };

  assert.equal(
    formatInitConfigWriteStatus(status, false, writtenFields),
    'Wrote .env:\n  Project ID: 12345\n  API key: set (••••)\n  Host: eu.posthog.com',
  );
  assert.equal(
    formatInitConfigWriteStatus(status, true, writtenFields),
    'Updated .env:\n  Project ID: 12345 (updated)\n  API key: set (••••) (updated)\n  Host: eu.posthog.com (updated)',
  );
});

test('buildGitignoreEnvGuard: no .gitignore -> creates the minimal credential guard and announces it loudly', () => {
  const guard = buildGitignoreEnvGuard(undefined);
  assert.equal(
    guard.updated,
    '# replaytest created this file to protect credentials and local replay artifacts.\n.env\n.replaytest/\nnode_modules/\n',
  );
  assert.equal(guard.note, 'Created .gitignore — protects your .env (real API key) and replaytest local artifacts from being committed.');
});

test('buildGitignoreEnvGuard: appends .env (newline-safe) when the file exists without coverage', () => {
  assert.equal(buildGitignoreEnvGuard('node_modules\n').updated, 'node_modules\n.env\n.replaytest/\n');
  assert.equal(buildGitignoreEnvGuard('node_modules').updated, 'node_modules\n.env\n.replaytest/\n');
  assert.equal(buildGitignoreEnvGuard('').updated, '.env\n.replaytest/\n');
  assert.match(buildGitignoreEnvGuard('node_modules\n').note, /Added \.env and \.replaytest\/ to \.gitignore/);
});

test('buildGitignoreEnvGuard: recognizes existing coverage variants and leaves the file alone', () => {
  for (const line of ['.env\n.replaytest/', '/.env\n/.replaytest/', '.env*\n.replaytest', '*.env\n/.replaytest', 'node_modules\n  .env  \n  .replaytest/  \ndist']) {
    const guard = buildGitignoreEnvGuard(line);
    assert.equal(guard.updated, undefined, `should not rewrite for ${JSON.stringify(line)}`);
    assert.match(guard.note, /gitignored ✓/);
  }
});

test('buildGitignoreEnvGuard: a non-matching mention (e.g. .envrc) still gets the append', () => {
  const guard = buildGitignoreEnvGuard('.envrc\n');
  assert.equal(guard.updated, '.envrc\n.env\n.replaytest/\n');
});

test('init: a bare workspace receives the minimal .gitignore and its credential-protection announcement', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-init-bare-'));
  const result = runCliInFixture(workspace, ['init', '--project', 'fixture-project', '--token', 'fixture-token']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8'),
    '# replaytest created this file to protect credentials and local replay artifacts.\n.env\n.replaytest/\nnode_modules/\n',
  );
  assert.match(result.stdout, /Created \.gitignore — protects your \.env \(real API key\) and replaytest local artifacts from being committed\./);
});

test('init: an existing .gitignore with both required entries remains byte-for-byte untouched', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-init-existing-gitignore-'));
  const gitignorePath = path.join(workspace, '.gitignore');
  const existing = '# maintained by the customer\n.env\n.replaytest/\ncustom-cache/\n';
  fs.writeFileSync(gitignorePath, existing, 'utf8');

  const result = runCliInFixture(workspace, ['init', '--project', 'fixture-project', '--token', 'fixture-token']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(gitignorePath, 'utf8'), existing);
  assert.match(result.stdout, /\.env and \.replaytest\/ are gitignored ✓/);
  assert.doesNotMatch(result.stdout, /Created \.gitignore/);
});

test('init refuses a read-only workspace with an errno-bearing statement that .env was not written', { skip: initReadOnlySkip }, (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-init-readonly-'));
  fs.chmodSync(workspace, 0o555);
  try {
    const combined = assertStacklessInitRefusal(
      runCliInFixture(workspace, ['init', '--project', 'fixture-project', '--token', 'fixture-token']),
    );
    assert.match(combined, /Could not initialize workspace .*\.env was not written/);
    assert.match(combined, /(?:EACCES|EPERM)/);
    assert.match(combined, /workspace writable|replaytest init/i);
  } finally {
    fs.chmodSync(workspace, 0o700);
  }
});

test('init refuses a read-only .gitignore while stating that .env was written', { skip: initReadOnlySkip }, (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-init-gitignore-readonly-'));
  const envPath = path.join(workspace, '.env');
  const gitignorePath = path.join(workspace, '.gitignore');
  fs.writeFileSync(envPath, 'POSTHOG_PROJECT_ID=old-project\nPOSTHOG_PERSONAL_API_KEY=old-token\n', 'utf8');
  fs.writeFileSync(gitignorePath, 'node_modules/\n', 'utf8');
  fs.chmodSync(gitignorePath, 0o444);
  try {
    const combined = assertStacklessInitRefusal(
      runCliInFixture(workspace, ['init', '--project', 'fixture-project', '--token', 'fixture-token']),
    );
    assert.match(combined, /Could not initialize workspace .*\.env was written, but \.gitignore could not be updated/);
    assert.match(combined, /(?:EACCES|EPERM)/);
    assert.match(fs.readFileSync(envPath, 'utf8'), /POSTHOG_PROJECT_ID=fixture-project/);
    assert.match(combined, /Add \.env and \.replaytest\/ to \.gitignore/);
  } finally {
    fs.chmodSync(gitignorePath, 0o600);
  }
});

test('hasAnyConfig: true if EITHER a projectId or hasApiKey is present', () => {
  assert.equal(hasAnyConfig({ hasApiKey: false }), false);
  assert.equal(hasAnyConfig({ projectId: '12345', hasApiKey: false }), true);
  assert.equal(hasAnyConfig({ hasApiKey: true }), true);
  assert.equal(hasAnyConfig({ projectId: '12345', hasApiKey: true }), true);
});

test('buildInitSetupHint: tells the user which flags to pass, naming "replaytest init"', () => {
  const hint = buildInitSetupHint();
  assert.ok(hint.includes('--project'));
  assert.ok(hint.includes('--token'));
  assert.ok(hint.includes('replaytest init'));
});

test('formatConfigStatus: shows the projectId plainly and masks the key as present/absent, NEVER a value', () => {
  const configured = formatConfigStatus({ projectId: '123456', hasApiKey: true }, 'Configured');
  assert.equal(
    configured,
    'Configured:\n  Project ID: 123456\n  API key: set (••••)\n  Host: us.posthog.com (default)',
  );
  assert.ok(!configured.includes('phx_'), 'must never render a raw key value');
});

test('formatConfigStatus: renders "(not set)" for a missing projectId or key', () => {
  const unset = formatConfigStatus({ hasApiKey: false }, 'Configured');
  assert.equal(
    unset,
    'Configured:\n  Project ID: (not set)\n  API key: (not set)\n  Host: us.posthog.com (default)',
  );
});

// ---------------------------------------------------------------------------
// "(updated)" markers: a --token change must be confirmable without
// ever echoing the key (presence alone can't distinguish old from new)
// ---------------------------------------------------------------------------

test('formatConfigStatus: marks exactly the just-written fields with "(updated)"', () => {
  const updated = formatConfigStatus({ projectId: '123456', hasApiKey: true }, 'Updated .env', { token: true });
  assert.equal(
    updated,
    'Updated .env:\n  Project ID: 123456\n  API key: set (••••) (updated)\n  Host: us.posthog.com (default)',
  );
});

test('formatConfigStatus: the plain status view (no updated arg) renders no "(updated)" marker', () => {
  const plain = formatConfigStatus({ projectId: '123456', hasApiKey: true }, 'Configured');
  assert.ok(!plain.includes('(updated)'));
});

test('buildInitNextStepHint: pins the canonical first-touch sequence and keeps doctor/preflight on branches', () => {
  const hint = buildInitNextStepHint();
  assert.equal(
    hint,
    'First touch: `replaytest init` (done) → `replaytest sessions` → `replaytest plan <distinctId>` → `replaytest scaffold <slug>` → run the generated test. Use `replaytest doctor` only when something is wrong; use `replaytest preflight <slug>` before a real run. Neither is a first-touch step.',
  );
});

test('formatConfigStatus: shows a configured host plainly (not a secret)', () => {
  const configured = formatConfigStatus(
    { projectId: '123456', hasApiKey: true, host: 'eu.posthog.com' },
    'Configured',
  );
  assert.equal(
    configured,
    'Configured:\n  Project ID: 123456\n  API key: set (••••)\n  Host: eu.posthog.com',
  );
});

test('formatConfigStatus: an unset host renders the explicit "us.posthog.com (default)" label', () => {
  const unset = formatConfigStatus({ projectId: '123456', hasApiKey: true }, 'Configured');
  assert.ok(unset.includes('Host: us.posthog.com (default)'));
});
