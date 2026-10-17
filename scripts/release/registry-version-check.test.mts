import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRegistryProbe, type RegistryProbe } from './registry-version-check.mts';

/**
 * Every fixture below is the REAL output of `npm view <spec> version --json`,
 * captured from npm 11.16.0 against the public registry — not a shape written
 * from memory. The trailing "a complete log of this run can be found in …" line
 * and the stack frames are the only edits: they carry machine-local paths.
 *
 * The four shapes matter because they are NOT distinguishable the obvious way.
 * A missing version on an EXISTING package, a package that does not exist, and a
 * registry that cannot be reached all exit non-zero with a JSON `error` object on
 * stdout. Only the error CODE separates "free to publish" from "we have no idea".
 */

const VERSION_MISSING_ON_EXISTING_PACKAGE: RegistryProbe = {
  status: 1,
  stdout: '{\n  "error": {\n    "code": "E404",\n    "summary": "No match found for version 0.1.0",\n    "detail": "The requested resource \'replaytest@0.1.0\' could not be found or you do not have permission to access it.\\n\\nNote that you can also install from a\\ntarball, folder, http url, or git url."\n  }\n}\n',
  stderr: 'npm error code E404\nnpm error 404 No match found for version 0.1.0\nnpm error 404\n',
};

const PACKAGE_DOES_NOT_EXIST: RegistryProbe = {
  status: 1,
  stdout: '{\n  "error": {\n    "code": "E404",\n    "summary": "Not Found - GET https://registry.npmjs.org/this-package-does-not-exist-replaytest-probe - Not found",\n    "detail": "The requested resource \'this-package-does-not-exist-replaytest-probe@1.0.0\' could not be found or you do not have permission to access it."\n  }\n}\n',
  stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/this-package-does-not-exist-replaytest-probe - Not found\n',
};

const VERSION_ALREADY_PUBLISHED: RegistryProbe = {
  status: 0,
  stdout: '"0.0.3"\n',
  stderr: '',
};

const REGISTRY_UNREACHABLE: RegistryProbe = {
  status: 1,
  stdout: '{\n  "error": {\n    "code": "ECONNREFUSED",\n    "summary": "FetchError: request to http://127.0.0.1:9/replaytest failed, reason: connect ECONNREFUSED 127.0.0.1:9",\n    "detail": "If you are behind a proxy, please make sure that the \'proxy\' config is set properly.  See: \'npm help config\'"\n  }\n}\n',
  stderr: 'npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\n',
};

test('a version missing from an existing package is free to publish', () => {
  const verdict = classifyRegistryProbe(VERSION_MISSING_ON_EXISTING_PACKAGE, '0.1.0');
  assert.equal(verdict.free, true);
  assert.equal(verdict.outcome, 'unpublished');
  assert.match(verdict.reason, /not on the registry/);
});

test('a package that does not exist yet is free to publish', () => {
  const verdict = classifyRegistryProbe(PACKAGE_DOES_NOT_EXIST, '1.0.0');
  assert.equal(verdict.free, true);
  assert.equal(verdict.outcome, 'unpublished');
});

test('a version already on the registry is refused', () => {
  const verdict = classifyRegistryProbe(VERSION_ALREADY_PUBLISHED, '0.0.3');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'published');
  assert.match(verdict.reason, /already on the registry/);
});

test('a registry that cannot be reached is refused, never read as "unpublished"', () => {
  // The whole point of the code check. This probe fails exactly like the two
  // E404 probes above — non-zero exit, JSON error object on stdout. A classifier
  // that treated "it failed" as "the version is free" would wave a duplicate
  // publish through on the one day the registry is down.
  const verdict = classifyRegistryProbe(REGISTRY_UNREACHABLE, '0.1.0');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'error');
  assert.match(verdict.reason, /ECONNREFUSED/);
});

test('an empty success — a range that matched nothing — is free to publish', () => {
  for (const stdout of ['', '\n', '[]', '[]\n', '{}']) {
    const verdict = classifyRegistryProbe({ status: 0, stdout, stderr: '' }, '0.1.0');
    assert.equal(verdict.free, true, JSON.stringify(stdout));
    assert.equal(verdict.outcome, 'unpublished', JSON.stringify(stdout));
  }
});

test('a success that lists the wanted version among several is refused', () => {
  const verdict = classifyRegistryProbe({ status: 0, stdout: '[\n  "0.0.3",\n  "0.1.0"\n]\n', stderr: '' }, '0.1.0');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'published');
});

test('a success that answers with some OTHER version is refused rather than guessed at', () => {
  const verdict = classifyRegistryProbe({ status: 0, stdout: '"0.9.9"\n', stderr: '' }, '0.1.0');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'error');
});

test('a non-zero exit with no JSON at all is refused and quotes what npm said', () => {
  const verdict = classifyRegistryProbe({ status: 1, stdout: '', stderr: 'npm error code E401\nnpm error 401 Unauthorized\n' }, '0.1.0');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'error');
  assert.match(verdict.reason, /E401/);
});

test('npm failing to start at all is refused, not read as a missing version', () => {
  const verdict = classifyRegistryProbe({ status: null, stdout: '', stderr: 'npm could not be started: spawn npm ENOENT' }, '0.1.0');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'error');
  assert.match(verdict.reason, /ENOENT/);
});

test('a success carrying output that is not JSON is refused', () => {
  const verdict = classifyRegistryProbe({ status: 0, stdout: 'npm warn using --force\n', stderr: '' }, '0.1.0');
  assert.equal(verdict.free, false);
  assert.equal(verdict.outcome, 'error');
});
