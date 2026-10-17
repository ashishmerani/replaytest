import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { acquireStateLock, releaseStateLock, StateLockFencedError, verifyStateLock } from './state-lock.js';
import { createStatePublicationLedger, createStateWriterTestExemption, mergeStateLockWarnings, makeStateArtifactWriter, releaseStateLockWithDisclosure, writeStateFile } from './state-writes.js';

test('state facade preserves the complete byte sequence through atomic publication', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writes-'));
  const target = path.join(directory, 'state.json');
  const content = '{\n  "z": 1,\n  "a": 2\n}\n';
  const handle = acquireStateLock(directory, 'triage', { waitMs: 0 });
  writeStateFile('triage-report-cache', target, content, { stateLockHandle: handle });
  assert.equal(fs.readFileSync(target, 'utf8'), content);
  releaseStateLock(handle);
});

test('state facade adapter keeps the existing ArtifactWriter seam usable', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writer-adapter-'));
  const target = path.join(directory, 'hashes.json');
  assert.throws(() => makeStateArtifactWriter(), /state-artifact write refused/);
  const writer = makeStateArtifactWriter({
    testOnlyExemption: createStateWriterTestExemption('unit-test adapter fixture'),
  });
  writer('spec-emitted-hashes', target, '{"entries":[]}\n');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"entries":[]}\n');
});

test('state facade fences a stale generation before it publishes', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writes-fence-'));
  const target = path.join(directory, 'state.json');
  const first = acquireStateLock(directory, 'heal', { waitMs: 0 });
  const replacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
  try {
    assert.throws(
      () => writeStateFile('heal-latest-state', target, 'stale\n', { stateLockHandle: first }),
      StateLockFencedError,
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    releaseStateLock(replacement);
  }
});

test('state facade verifies the lease again when an already-bound writer publishes', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writer-write-time-'));
  const target = path.join(directory, 'state.json');
  const handle = acquireStateLock(directory, 'triage', { waitMs: 0 });
  const writer = makeStateArtifactWriter({ stateLockHandle: handle });
  releaseStateLock(handle);
  assert.throws(
    () => writer('triage-report-cache', target, 'stale\n'),
    StateLockFencedError,
  );
  assert.equal(fs.existsSync(target), false, 'a lease released after writer construction cannot authorize a later publication');
});

test('a steal after the temp write is refused before the publishing rename', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writes-window-'));
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(target, 'old\n', 'utf8');
  const first = acquireStateLock(directory, 'heal', { waitMs: 0 });
  let replacement: ReturnType<typeof acquireStateLock> | undefined;
  let sawTemp = false;
  try {
    assert.throws(() => writeStateFile('heal-latest-state', target, 'new\n', {
      stateLockHandle: first,
      beforePublishFence: () => {
        sawTemp = fs.readdirSync(directory).some((name) => name.includes('.atomic-'));
        replacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
      },
    }), StateLockFencedError);
    assert.equal(sawTemp, true, 'the fence is evaluated after the temp write, not before it');
    assert.equal(fs.readFileSync(target, 'utf8'), 'old\n', 'an abandoned publication never renames over the previous bytes');
    assert.equal(fs.readdirSync(directory).filter((name) => name.includes('.atomic-')).length, 0, 'the temp is retired');
  } finally {
    if (replacement !== undefined) releaseStateLock(replacement);
    else releaseStateLock(first);
  }
});

test('a steal during the temp fsync is refused before the publishing rename', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writes-fsync-window-'));
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(target, 'old\n', 'utf8');
  const first = acquireStateLock(directory, 'heal', { waitMs: 0 });
  let replacement: ReturnType<typeof acquireStateLock> | undefined;
  try {
    assert.throws(() => writeStateFile('heal-latest-state', target, 'new\n', {
      stateLockHandle: first,
      fsync: (fd) => {
        fs.fsyncSync(fd);
        if (replacement === undefined) replacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
      },
    }), StateLockFencedError);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old\n', 'the fence runs after the temp fsync and preserves prior bytes');
  } finally {
    if (replacement !== undefined) releaseStateLock(replacement);
    else releaseStateLock(first);
  }
});

test('a lease change between EPERM rename attempts fences before the retry syscall', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writes-retry-'));
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(target, 'old\n', 'utf8');
  const first = acquireStateLock(directory, 'heal', { waitMs: 0 });
  let replacement: ReturnType<typeof acquireStateLock> | undefined;
  let attempts = 0;
  let authorityReads = 0;
  try {
    assert.throws(() => writeStateFile('heal-latest-state', target, 'stale\n', {
      stateLockHandle: first,
      rename: (from, to) => {
        attempts += 1;
        if (attempts === 1) {
          replacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
          writeStateFile('heal-latest-state', target, 'successor\n', { stateLockHandle: replacement });
          const error = new Error('simulated Windows rename retry') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        fs.renameSync(from, to);
      },
      onVerifyStateLock: () => { authorityReads += 1; },
    }), StateLockFencedError);
    assert.equal(attempts, 1, 'the fenced holder never reaches the second rename attempt');
    assert.equal(authorityReads, 3, 'one pre-sequence read plus one read for each EPERM retry attempt reaches the production writer seam');
    assert.equal(fs.readFileSync(target, 'utf8'), 'successor\n');
    assert.doesNotThrow(() => verifyStateLock(replacement!));
  } finally {
    if (replacement !== undefined) releaseStateLock(replacement);
    else releaseStateLock(first);
  }
});

test('the publication ledger discloses landed state after a refused second write', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-writes-ledger-'));
  const target = path.join(directory, 'state.json');
  const firstLedger = createStatePublicationLedger();
  let firstReplacement: ReturnType<typeof acquireStateLock> | undefined;
  const first = acquireStateLock(directory, 'heal', {
    waitMs: 0,
    onBeforeRelease: (owned) => {
      firstReplacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
      assert.equal(fs.existsSync(owned.path), true);
    },
  });
  try {
    writeStateFile('heal-latest-state', target, 'landed\n', { stateLockHandle: first, publicationLedger: firstLedger });
    const progress: string[] = [];
    releaseStateLockWithDisclosure(first, firstLedger, 'heal', (line) => progress.push(line));
    assert.equal(firstLedger.warnings.length, 1);
    assert.equal(firstLedger.warnings[0]?.files.some((file) => file.endsWith('state.json')), true);
    assert.equal(progress.length, 1);
  } finally {
    if (firstReplacement !== undefined) releaseStateLock(firstReplacement);
  }

  const emptyLedger = createStatePublicationLedger();
  let emptyReplacement: ReturnType<typeof acquireStateLock> | undefined;
  const emptyHandle = acquireStateLock(directory, 'triage', {
    waitMs: 0,
    onBeforeRelease: () => { emptyReplacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true); },
  });
  try {
    const progress: string[] = [];
    releaseStateLockWithDisclosure(emptyHandle, emptyLedger, 'triage', (line) => progress.push(line));
    assert.equal(emptyLedger.warnings.length, 0);
    assert.deepEqual(progress, []);
  } finally {
    if (emptyReplacement !== undefined) releaseStateLock(emptyReplacement);
  }

  const secondLedger = createStatePublicationLedger();
  const second = acquireStateLock(directory, 'heal', { waitMs: 0 });
  let secondReplacement: ReturnType<typeof acquireStateLock> | undefined;
  try {
    writeStateFile('heal-latest-state', target, 'first\n', { stateLockHandle: second, publicationLedger: secondLedger });
    try {
      writeStateFile('heal-latest-state', target, 'refused\n', {
        stateLockHandle: second,
        publicationLedger: secondLedger,
        beforePublishFence: () => { secondReplacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true); },
      });
    } catch { /* the release path below discloses the earlier successful publication */ }
    const progress: string[] = [];
    releaseStateLockWithDisclosure(second, secondLedger, 'heal', (line) => progress.push(line));
    assert.equal(secondLedger.publications.length, 1);
    assert.equal(secondLedger.warnings.length, 1);
    assert.deepEqual(secondLedger.warnings[0]?.files, [target]);
    assert.equal(progress.length, 1);
  } finally {
    if (secondReplacement !== undefined) releaseStateLock(secondReplacement);
  }
});

test('one retire envelope warning unions files from multiple fenced state leases', () => {
  const warnings = [] as ReturnType<typeof createStatePublicationLedger>['warnings'];
  mergeStateLockWarnings(warnings, [{
    code: 'state-lock-released-late',
    message: 'first',
    action: 're-run',
    verb: 'retire',
    files: ['.replaytest/state/one.json'],
  }]);
  mergeStateLockWarnings(warnings, [{
    code: 'state-lock-released-late',
    message: 'second',
    action: 're-run',
    verb: 'retire',
    files: ['.replaytest/state/two.json', '.replaytest/state/one.json'],
  }]);
  assert.equal(warnings.length, 1, 'a multi-row retire run emits one envelope entry per warning code');
  assert.deepEqual(warnings[0]?.files, ['.replaytest/state/one.json', '.replaytest/state/two.json']);
  assert.match(warnings[0]?.message ?? '', /one\.json and \.replaytest\/state\/two\.json/);
});

test('every state-lock disclosure verb delivers its warning through the shared production release seam', (t: TestContext) => {
  const verbs = ['accept', 'heal', 'retire', 'triage', 'suite-health', 'fix-selector', 'scaffold', 'sessions'] as const;
  for (const verb of verbs) {
    const directory = makeTempDir(t, path.join(os.tmpdir(), `replaytest-state-release-${verb}-`));
    const ledger = createStatePublicationLedger();
    const file = path.join(directory, `${verb}.json`);
    const handle = acquireStateLock(directory, verb, {
      waitMs: 0,
      onBeforeRelease: (owned) => { fs.unlinkSync(owned.path); },
    });
    try {
      writeStateFile('heal-latest-state', file, `${verb}\n`, { stateLockHandle: handle, publicationLedger: ledger });
      const progress: string[] = [];
      releaseStateLockWithDisclosure(handle, ledger, verb, (line) => progress.push(line));
      assert.deepEqual(ledger.warnings.map((warning) => warning.code), ['state-lock-released-late'], `${verb}: the envelope disposition is delivered`);
      assert.deepEqual(ledger.warnings[0]?.files, [file], `${verb}: the landed shared-state file is named`);
      assert.deepEqual(progress, [ledger.warnings[0]?.message], `${verb}: the prose warning uses the progress channel exactly once`);
    } finally {
      // The test's production release seam deliberately removed this lease.
    }
  }
});
