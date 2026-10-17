/**
 * Unit tests for `findPiiLikeStrings` — pure, no network. See src/pii-lint.ts
 * module header for the detector rules under test. The truth table below
 * covers every named acceptance case: hits (email,
 * 7+ digit run with/without dashes, provider token) and misses (6-digit id, `:id`-
 * canonicalized route, hex session id, ordinary capitalized UI text).
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildPrivacyDisclosure,
  checkPrivacyGitIgnore,
  describePiiKind,
  findPiiLikeStrings,
  privacyGitIgnoreWarningCopy,
  scanForPii,
} from './pii-lint.js';

const providerTokenFixture = `phc_${'a'.repeat(30)}`;

// ---------------------------------------------------------------------------
// email — hits
// ---------------------------------------------------------------------------

test('findPiiLikeStrings: an email-shaped substring is detected', () => {
  const findings = findPiiLikeStrings("getByRole('link', { name: 'priya@example.com' })");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'email');
});

test('findPiiLikeStrings: an email excerpt is redacted — first 3 + last char of the local part, domain hidden entirely', () => {
  const findings = findPiiLikeStrings('priya@example.com');
  assert.equal(findings[0].excerpt, 'pri…a@…');
  // The raw local part and the full domain never appear in the excerpt.
  assert.ok(!findings[0].excerpt.includes('priya'));
  assert.ok(!findings[0].excerpt.includes('example.com'));
});

test('findPiiLikeStrings: an email embedded inside a longer sentence is still found', () => {
  const findings = findPiiLikeStrings('Contact us at support@acme.io for help');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'email');
});

test('findPiiLikeStrings: multiple emails in one string each produce a finding', () => {
  const findings = findPiiLikeStrings('cc: alice@example.com, bob@example.com');
  assert.equal(findings.filter((f) => f.kind === 'email').length, 2);
});

// ---------------------------------------------------------------------------
// long-number — hits
// ---------------------------------------------------------------------------

test('findPiiLikeStrings: a plain run of 7+ digits is detected', () => {
  const findings = findPiiLikeStrings('Account #4821992');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'long-number');
});

test('findPiiLikeStrings: a hyphen-grouped long number (phone/account shape) is detected', () => {
  const findings = findPiiLikeStrings('482-199-2001');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'long-number');
});

test('findPiiLikeStrings: a space-grouped long number (card shape) is detected', () => {
  const findings = findPiiLikeStrings('4242 4242 4242 4242');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'long-number');
});

test('findPiiLikeStrings: a long-number excerpt is redacted to first 3 + last 2 characters', () => {
  const findings = findPiiLikeStrings('Account #4821992');
  assert.equal(findings[0].excerpt, '482…92');
  assert.ok(!findings[0].excerpt.includes('4821992'));
});

// ---------------------------------------------------------------------------
// recording detector scope — promotion scan only
// ---------------------------------------------------------------------------

test('scanForPii: long-number detection is silent for archive/recordings paths', () => {
  for (const value of ['1577836800000', '1577836799999', '4242424242424242', '482-199-2001']) {
    assert.deepEqual(scanForPii(value, 'archive/recordings/session/payload-a.jsonl'), [], value);
    assert.equal(findPiiLikeStrings(value)[0].kind, 'long-number', value);
  }
});

test('scanForPii: email and provider-token detectors remain active for archive/recordings paths', () => {
  const findings = scanForPii(`contact=ops@example.test token=${providerTokenFixture}`, 'archive/recordings/session/payload-a.jsonl');
  assert.deepEqual(findings.map((finding) => finding.kind).sort(), ['email', 'provider-token']);
});

test('scanForPii: long-number behavior is unchanged for every non-recordings path', () => {
  for (const value of ['15778368000000', '4242424242424242']) {
    for (const filePath of ['archive/events/session.jsonl', 'src/sidecar.ts', 'docs/example.md']) {
      const findings = scanForPii(value, filePath);
      assert.equal(findings.length, 1, `${value} in ${filePath}`);
      assert.equal(findings[0].kind, 'long-number', `${value} in ${filePath}`);
      assert.equal(findings[0].excerpt, findPiiLikeStrings(value)[0].excerpt, `${value} in ${filePath}`);
      assert.equal(
        findings[0].baselineKey,
        createHash('sha256').update(`${value}\0${filePath}`).digest('hex'),
        `${value} in ${filePath}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// provider token — hits and neutralized placeholder miss
// ---------------------------------------------------------------------------

test('findPiiLikeStrings: a provider-token-shaped substring is detected and redacted', () => {
  const findings = findPiiLikeStrings(`captured config token=${providerTokenFixture}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'provider-token');
  assert.equal(findings[0].excerpt, 'phc_<redacted>');
  assert.ok(!findings[0].excerpt.includes(providerTokenFixture));
});

test('findPiiLikeStrings: the neutralized provider-token placeholder does not trigger', () => {
  assert.deepEqual(findPiiLikeStrings('demo-token-neutralized'), []);
});

test('buildPrivacyDisclosure: distinctId scans email/token classes, but excludes numeric IDs and canonical UUIDs', () => {
  assert.equal(buildPrivacyDisclosure([{ path: 'source.distinctId', value: '1234567890123456' }]), undefined);
  assert.equal(buildPrivacyDisclosure([{ path: 'source.distinctId', value: '12345678-1234-7234-9234-123456789012' }]), undefined);
  assert.equal(buildPrivacyDisclosure([{ path: 'source.distinctId', value: '12345678-1234-7234-9234-123456789012', kinds: ['email', 'long-number', 'provider-token'] }]), undefined);
  assert.equal(buildPrivacyDisclosure([{ path: 'source.distinctId', value: 'user@example.test' }])?.findings[0]?.kind, 'email');
  assert.equal(buildPrivacyDisclosure([{ path: 'source.distinctId', value: providerTokenFixture }])?.findings[0]?.kind, 'provider-token');
  assert.equal(describePiiKind('provider-token'), 'PostHog-project-token-shaped');
});

test('buildPrivacyDisclosure: scans the declared pre-render carrier fields and redacts findings', () => {
  const disclosure = buildPrivacyDisclosure([
    { path: 'start', value: '/invoices/inv-1234567' },
    { path: 'dataRequirements[].path', value: '/customers/priya@example.test' },
    { path: 'source.locatorRepairs[].replacementLocator', value: "getByLabel('card-4242424242424242')" },
  ]);
  assert.ok(disclosure !== undefined);
  assert.deepEqual([...new Set(disclosure.findings.map((finding) => finding.path))], [
    'start',
    'dataRequirements[].path',
    'source.locatorRepairs[].replacementLocator',
  ]);
  assert.ok(disclosure.findings.every((finding) => !finding.excerpt.includes('priya@example.test')));
  assert.match(disclosure.caveat, /^Possible user data in 3 structured artifact values/);
});

test('checkPrivacyGitIgnore: a repository with an ignored replaytest directory returns the best-effort safe state', () => {
  const result = checkPrivacyGitIgnore(process.cwd());
  assert.equal(result.status, 'ignored');
  assert.equal(result.warning, undefined);
  assert.equal(result.code, undefined);
});

test('checkPrivacyGitIgnore: an unavailable workspace is disclosed rather than treated as ignored', () => {
  const result = checkPrivacyGitIgnore('/definitely/not/a/replaytest-workspace');
  assert.equal(result.status, 'git-unavailable');
  assert.equal(result.code, 'privacy-workspace-probe-skipped');
  assert.equal(result.warning, undefined);
  assert.match(result.note ?? '', /^privacy-workspace-probe-skipped:/);
});

test('checkPrivacyGitIgnore: a real non-repository returns a registered skip note without an assertive warning', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-gitignore-nonrepo-'));
  const result = checkPrivacyGitIgnore(workspace, '.');
  assert.equal(result.status, 'not-a-repository');
  assert.equal(result.warning, undefined);
  assert.equal(result.code, 'privacy-workspace-probe-skipped');
  assert.match(result.note ?? '', /^privacy-workspace-probe-skipped:/);
});

test('checkPrivacyGitIgnore: an established repository with an unignored destination retains the warning', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-gitignore-unignored-'));
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' });
  assert.equal(initialized.status, 0);
  const result = checkPrivacyGitIgnore(workspace, '.', '.replaytest/');
  assert.equal(result.status, 'not-ignored');
  assert.equal(result.note, undefined);
  assert.equal(result.code, 'privacy-workspace-not-ignored');
  assert.equal(result.warning, privacyGitIgnoreWarningCopy('.replaytest/'));
  assert.equal(result.warning, 'privacy-workspace-not-ignored: .replaytest/ is not git-ignored; local privacy state may be committed. Add .replaytest/ to .gitignore before continuing.');
});

test('checkPrivacyGitIgnore: an unignored retirement destination names that display path in both warning sentences', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-gitignore-retired-unignored-'));
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' });
  assert.equal(initialized.status, 0);
  const result = checkPrivacyGitIgnore(workspace, '.replaytest/retired/', '.replaytest/retired/');
  assert.equal(result.status, 'not-ignored');
  assert.equal(result.warning, 'privacy-workspace-not-ignored: .replaytest/retired/ is not git-ignored; local privacy state may be committed. Add .replaytest/retired/ to .gitignore before continuing.');
  assert.doesNotMatch(result.warning ?? '', /\.replaytest\/ is/);
});

test('checkPrivacyGitIgnore: a missing git executable returns the same registered skip note', () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/definitely/no-git-on-this-path';
  try {
    const result = checkPrivacyGitIgnore(process.cwd(), '.');
    assert.equal(result.status, 'git-unavailable');
    assert.equal(result.warning, undefined);
    assert.equal(result.code, 'privacy-workspace-probe-skipped');
    assert.match(result.note ?? '', /^privacy-workspace-probe-skipped:/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

// ---------------------------------------------------------------------------
// misses — the acceptance list's explicit non-triggers
// ---------------------------------------------------------------------------

test('findPiiLikeStrings: a short id (<=6 digits) does not fire', () => {
  assert.deepEqual(findPiiLikeStrings('id-482199'), []);
  assert.deepEqual(findPiiLikeStrings('#123456'), []);
});

test('findPiiLikeStrings: a `:id`-canonicalized route does not fire', () => {
  assert.deepEqual(findPiiLikeStrings('/invoices/' + ':id' + '/pay'), []);
});

test('findPiiLikeStrings: a hex session id (digits and letters interleaved, no 7+ pure-digit run) does not fire', () => {
  // Chosen so no maximal pure-digit substring reaches 7 digits — letters
  // break the run every few characters, as a realistic hex/session id does.
  assert.deepEqual(findPiiLikeStrings('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), []);
});

test('findPiiLikeStrings: ordinary capitalized UI text does not fire (name-shaped detection is out of scope by design)', () => {
  assert.deepEqual(findPiiLikeStrings('Create Customer'), []);
  assert.deepEqual(findPiiLikeStrings('Pay an invoice'), []);
  assert.deepEqual(findPiiLikeStrings('getByRole(\'button\', { name: \'Submit payment\' })'), []);
});

test('findPiiLikeStrings: a clean/empty string returns no findings', () => {
  assert.deepEqual(findPiiLikeStrings(''), []);
  assert.deepEqual(findPiiLikeStrings('Invoice confirmation'), []);
});
