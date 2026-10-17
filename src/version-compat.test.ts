import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  compareVersions,
  formatVersionList,
  isExactVerifiedPosthogCliVersion,
  isVersionAtLeast,
  isVersionWithinPosthogCliRange,
  NODE_ENGINES_RANGE,
  NODE_FLOOR,
  NODE_VERIFIED_NOTE,
  parseVersion,
  PLAYWRIGHT_COMPAT_CLAIM,
  PLAYWRIGHT_FLOOR,
  PLAYWRIGHT_VERIFIED_AT,
  POSTHOG_CLI_COMPAT_CLAIM,
  posthogCliKnownGoodRange,
  POSTHOG_CLI_VERIFIED_VERSIONS,
} from './version-compat.js';

// ---------------------------------------------------------------------------
// The locked constants themselves (build evidence) — a drift alarm if
// anyone edits a value without going through the design doc.
// ---------------------------------------------------------------------------

// The "verified at" claim is EARNED per version (the generated suite through `test:heal`
// against the live demo apps), never assumed: the installed Playwright must be one of the
// listed versions, so a bump that lands without its verification reds here instead of
// shipping an unverified claim.
test('the installed @playwright/test version is one the claim was earned on', () => {
  const installed = createRequire(import.meta.url)('@playwright/test/package.json') as { version: string };
  assert.ok(PLAYWRIGHT_VERIFIED_AT.includes(installed.version),
    `@playwright/test ${installed.version} is installed but PLAYWRIGHT_VERIFIED_AT lists ${PLAYWRIGHT_VERIFIED_AT.join(', ')} — run the special lane (test:heal against both demo apps) and append it`);
});

test('locked constants match the build evidence', () => {
  assert.equal(PLAYWRIGHT_FLOOR, '1.30.0');
  assert.deepEqual(PLAYWRIGHT_VERIFIED_AT, ['1.30.0', '1.61.0', '1.62.1', '1.63.0']);
  assert.equal(PLAYWRIGHT_COMPAT_CLAIM, 'verified at 1.30.0, 1.61.0, 1.62.1, and 1.63.0; between = expected but untested.');
  assert.equal(NODE_FLOOR, 22);
  assert.equal(NODE_ENGINES_RANGE, '>=22');
  assert.equal(NODE_VERIFIED_NOTE, 'Node 22 LTS and Node 24 (full test suite + a packaged-install consumer check)');
  assert.deepEqual(POSTHOG_CLI_VERIFIED_VERSIONS, ['0.7.32', '0.8.4', '0.9.1', '0.9.4', '0.10.0', '0.13.3', '0.16.0']);
  assert.equal(POSTHOG_CLI_COMPAT_CLAIM, 'Verified at 0.7.32, 0.8.4, 0.9.1, 0.9.4, 0.10.0, 0.13.3, and 0.16.0; the install command pins the newest.');
});

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

test('parseVersion parses a plain x.y.z string', () => {
  assert.deepEqual(parseVersion('1.30.0'), [1, 30, 0]);
});

test('parseVersion tolerates a leading "v" and trailing pre-release/build metadata', () => {
  assert.deepEqual(parseVersion('v1.61.0'), [1, 61, 0]);
  assert.deepEqual(parseVersion('1.30.0-rc1'), [1, 30, 0]);
  assert.deepEqual(parseVersion('22.22.2'), [22, 22, 2]);
});

test('parseVersion returns undefined for unparseable input', () => {
  assert.equal(parseVersion('not-a-version'), undefined);
  assert.equal(parseVersion(''), undefined);
});

// ---------------------------------------------------------------------------
// compareVersions / isVersionAtLeast
// ---------------------------------------------------------------------------

test('compareVersions orders by major, then minor, then patch', () => {
  assert.ok((compareVersions('1.61.0', '1.30.0') ?? 0) > 0);
  assert.ok((compareVersions('1.30.0', '1.61.0') ?? 0) < 0);
  assert.equal(compareVersions('1.30.0', '1.30.0'), 0);
  assert.ok((compareVersions('2.0.0', '1.99.99') ?? 0) > 0);
  assert.ok((compareVersions('1.9.0', '1.10.0') ?? 0) < 0); // numeric, not lexicographic
});

test('compareVersions returns undefined when either side fails to parse', () => {
  assert.equal(compareVersions('nonsense', '1.30.0'), undefined);
  assert.equal(compareVersions('1.30.0', 'nonsense'), undefined);
});

test('isVersionAtLeast: found version meeting or exceeding the floor', () => {
  assert.equal(isVersionAtLeast('1.61.0', PLAYWRIGHT_FLOOR), true);
  assert.equal(isVersionAtLeast('1.30.0', PLAYWRIGHT_FLOOR), true); // floor itself counts
});

test('isVersionAtLeast: found version older than the floor', () => {
  assert.equal(isVersionAtLeast('1.29.0', PLAYWRIGHT_FLOOR), false);
});

test('isVersionAtLeast: undefined when the candidate cannot be parsed', () => {
  assert.equal(isVersionAtLeast('garbage', PLAYWRIGHT_FLOOR), undefined);
});

// ---------------------------------------------------------------------------
// posthogCliKnownGoodRange / isVersionWithinPosthogCliRange
// ---------------------------------------------------------------------------

test('posthogCliKnownGoodRange: min/max/label derive from the sorted verified list', () => {
  const range = posthogCliKnownGoodRange();
  assert.equal(range.min, '0.7.32');
  assert.equal(range.max, '0.16.0');
  assert.equal(range.label, '0.7.32–0.16.0');
});

test('isVersionWithinPosthogCliRange: exact and in-between versions are in range', () => {
  assert.equal(isVersionWithinPosthogCliRange('0.7.32'), true);
  assert.equal(isVersionWithinPosthogCliRange('0.8.0'), true);
  assert.equal(isVersionWithinPosthogCliRange('0.9.0'), true);
});

test('isExactVerifiedPosthogCliVersion: only explicitly verified versions are exact', () => {
  assert.equal(isExactVerifiedPosthogCliVersion('0.7.32'), true);
  assert.equal(isExactVerifiedPosthogCliVersion('0.8.4'), true);
  assert.equal(isExactVerifiedPosthogCliVersion('0.9.1'), true);
  assert.equal(isExactVerifiedPosthogCliVersion('0.8.0'), false);
  assert.equal(isExactVerifiedPosthogCliVersion('0.9.0'), false);
});

test('formatVersionList renders an out-of-order append in ascending version order', () => {
  assert.equal(formatVersionList(['0.8.4', '0.7.99', '0.7.32']), '0.7.32, 0.7.99, and 0.8.4');
});

test('isVersionWithinPosthogCliRange: out-of-range (both below and above)', () => {
  assert.equal(isVersionWithinPosthogCliRange('0.7.0'), false);
  // Above-range fixture: a version no real release will reach, so a future pin bump cannot
  // silently swallow it (a real next-release number here moves with the range and inverts the case).
  assert.equal(isVersionWithinPosthogCliRange('9.99.99'), false);
  // The sentinel's premise, pinned: it must stay strictly above the derived max, so a pin bump
  // that ever reached it would fail HERE (naming the sentinel) instead of silently inverting
  // the out-of-range case above.
  assert.ok((compareVersions('9.99.99', posthogCliKnownGoodRange().max) ?? 0) > 0);
});

test('isVersionWithinPosthogCliRange: undefined when unparseable', () => {
  assert.equal(isVersionWithinPosthogCliRange('not-a-version'), undefined);
});
