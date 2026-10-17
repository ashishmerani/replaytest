/**
 * Synthetic, PII-free archive fixtures for `archive-adapter.ts`.
 *
 * These tests intentionally do not read `archive/**` and do not commit copied
 * recording bytes. Each archive bundle is generated under the OS temp dir from
 * hand-built rows/rrweb trees that contain only fake ids and labels.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from '../test-support/temp-dir.test-support.js';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  ArchiveIntegrityError,
  ArchiveMissingEventsError,
  fetchArchiveFullReplayStream,
  fetchArchiveNeutralSessionsWithDomEnrichment,
} from './archive-adapter.js';
import {
  buildRouteIndex,
  buildRouteTimeline,
  decodeFullReplayStream,
  enrichTargetsFromDom,
  parseFullSnapshotTrees,
  toNeutralSession,
  type PostHogEventRow,
  type SessionRecordingRow,
} from './posthog-adapter.js';
import { runPlan, runSessions } from '../cli.js';
import { COMPLETION_CENSUS_PATH } from '../completion-census.js';
import { formatLocalTime } from '../local-time.js';
import { isTransientProbePath, readSourceFile, transientProbePath, withSourceSnapshotRetry } from '../test-discovery.js';

const SESSION_ID = 'archive-session-1';
const DISTINCT_ID = 'archive-user-1';
const PAY_URL = 'http://app.test/checkout/pay';
const DONE_URL = 'http://app.test/checkout/complete';
const ARCHIVED_AT = '2026-07-10T03:04:05.000Z';

interface FixtureArchive {
  root: string;
  sessionId: string;
}

function makeArchive(t: TestContext, opts: {
  name: string;
  includeEvents?: boolean;
  corruptBlobHash?: boolean;
  splitBlobs?: boolean;
  blobLines?: string[];
  eventJsonl?: string;
  console?: Pick<SessionRecordingRow, 'console_error_count' | 'console_warn_count' | 'console_log_count'>;
}): FixtureArchive {
  const root = makeTempDir(t, path.join(os.tmpdir(), `${opts.name}-`));
  const sessionId = SESSION_ID;
  const files: Array<{ path: string; sha256: string; size: number }> = [];

  writeTracked(root, 'recordings/archive-session-1/sources.json', Buffer.from('{"sources":[]}', 'utf8'), files);
  const lines = opts.blobLines ?? snapshotLines();
  if (opts.splitBlobs) {
    writeTracked(root, 'recordings/archive-session-1/blob_v2-00000-00000.jsonl', Buffer.from(`${lines[0]}\n`, 'utf8'), files);
    writeTracked(root, 'recordings/archive-session-1/blob_v2-00001-00001.jsonl', Buffer.from(`${lines[1]}\n`, 'utf8'), files);
  } else {
    writeTracked(root, 'recordings/archive-session-1/blob_v2-00000-00001.jsonl', Buffer.from(`${lines.join('\n')}\n`, 'utf8'), files);
  }

  if (opts.includeEvents !== false) {
    writeTracked(root, `events/${sessionId}.jsonl`, Buffer.from(opts.eventJsonl ?? eventJsonl(), 'utf8'), files);
  }

  if (opts.corruptBlobHash) {
    const blob = files.find((file) => file.path.includes('blob_v2-'));
    if (blob !== undefined) blob.sha256 = '0'.repeat(64);
  }

  const metadata: SessionRecordingRow = {
    distinct_id: DISTINCT_ID,
    console_error_count: opts.console?.console_error_count ?? 0,
    console_warn_count: opts.console?.console_warn_count ?? 0,
    console_log_count: opts.console?.console_log_count ?? 0,
  };
  const manifest = {
    sessionId,
    archivedAt: ARCHIVED_AT,
    metadata,
    files,
    verification: { passed: true },
  };
  fs.writeFileSync(path.join(root, 'manifest.jsonl'), `\n${JSON.stringify(manifest)}\n`, 'utf8');
  return { root, sessionId };
}

function writeTracked(
  root: string,
  relativePath: string,
  body: Buffer,
  files: Array<{ path: string; sha256: string; size: number }>,
): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, body);
  files.push({ path: relativePath, sha256: sha256(body), size: body.length });
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function eventRows(): PostHogEventRow[] {
  return [
    row({ timestamp: '2026-07-10T02:00:00.000Z', event: '$pageview', url: PAY_URL, title: 'Checkout' }),
    row({
      timestamp: '2026-07-10T02:00:01.000Z',
      event: '$autocapture',
      event_type: 'change',
      url: PAY_URL,
      elements_chain: 'input:attr__name="name"nth-child="2"nth-of-type="1";form:attr__id="pay-form"nth-child="1"nth-of-type="1"',
      viewport_width: '1280',
      viewport_height: '720',
    }),
    row({
      timestamp: '2026-07-10T02:00:02.000Z',
      event: '$autocapture',
      event_type: 'click',
      url: PAY_URL,
      elements_chain: 'button:attr__type="submit"nth-child="4"nth-of-type="1"text="Submit payment";form:attr__id="pay-form"nth-child="1"nth-of-type="1"',
    }),
    row({
      timestamp: '2026-07-10T02:00:02.001Z',
      event: '$autocapture',
      event_type: 'submit',
      url: PAY_URL,
      elements_chain: 'form:attr__id="pay-form"nth-child="1"nth-of-type="1"',
    }),
    row({ timestamp: '2026-07-10T02:00:03.000Z', event: '$pageview', url: DONE_URL, title: 'Complete' }),
  ];
}

function eventJsonl(): string {
  return `${eventRows().map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function row(overrides: Partial<PostHogEventRow>): PostHogEventRow {
  return {
    timestamp: '2026-07-10T02:00:00.000Z',
    event: '$pageview',
    distinct_id: DISTINCT_ID,
    session_id: SESSION_ID,
    ...overrides,
  };
}

function snapshotLines(opts: { snapshotUrl?: string; includeMaskedField?: boolean } = {}): string[] {
  const snapshotUrl = opts.snapshotUrl ?? PAY_URL;
  const includeMaskedField = opts.includeMaskedField ?? true;
  const timestamp = Date.parse(snapshotUrl === PAY_URL ? '2026-07-10T02:00:00.500Z' : '2026-07-10T02:00:03.500Z');
  const tree = includeMaskedField
    ? {
      node: elementNode({
        tagName: 'form',
        attributes: { id: 'pay-form' },
        childNodes: [
          elementNode({ tagName: 'label', attributes: { for: 'name' }, childNodes: [textNode('Name on card')] }),
          elementNode({ tagName: 'input', attributes: { id: 'name', name: 'name', placeholder: 'Jane Test' } }),
          elementNode({ tagName: 'label', attributes: { for: 'card-number' }, childNodes: [textNode('Card number')] }),
          textNode('\n'),
          elementNode({
            tagName: 'input',
            attributes: { class: 'ph-no-capture', rr_width: '600px', rr_height: '39px' },
          }),
          elementNode({ tagName: 'button', attributes: { type: 'submit' }, childNodes: [textNode('Submit payment')] }),
        ],
      }),
    }
    : {
      node: elementNode({
        tagName: 'main',
        childNodes: [elementNode({ tagName: 'h1', childNodes: [textNode('Payment complete')] })],
      }),
    };
  return [
    JSON.stringify(['win', { type: 4, timestamp, data: { href: snapshotUrl } }]),
    JSON.stringify(['win', { type: 2, timestamp: timestamp + 100, data: gzipJson(tree), cv: '2024-10' }]),
  ];
}

/** The live fetcher's pure DOM-enrichment half, fed the archive fixture's exact JSONL bytes. */
function enrichLiveShapedFixtureBytes(eventJsonlText: string, blobJsonlText: string) {
  const sessions = toNeutralSession(
    eventJsonlText
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PostHogEventRow),
  );
  return sessions.flatMap((session) => {
    const routeMap = buildRouteIndex(parseFullSnapshotTrees(blobJsonlText), buildRouteTimeline(session.steps));
    return enrichTargetsFromDom([session], routeMap);
  });
}

/** Same synthetic bytes are decoded through the live-stream decoder and archive reader below. */
function fullReplayStreamLines(): string[] {
  const tree = {
    node: elementNode({
      tagName: 'main',
      childNodes: [elementNode({ tagName: 'h1', childNodes: [textNode('Archive complete')] })],
    }),
  };
  return [
    JSON.stringify(['archive-window-later', { type: 3, timestamp: 900, data: { source: 0 } }]),
    JSON.stringify(['archive-window-earlier', { type: 4, timestamp: 100, data: { href: DONE_URL } }]),
    JSON.stringify([
      'archive-window-earlier',
      { type: 2, timestamp: 200, data: gzipJson(tree), cv: '2024-10' },
    ]),
    JSON.stringify({ type: 5, timestamp: 50, data: { tag: 'bare-event' } }),
  ];
}

function gzipJson(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
}

function elementNode(opts: { tagName: string; attributes?: Record<string, string>; childNodes?: unknown[] }): unknown {
  return { type: 2, tagName: opts.tagName, attributes: opts.attributes ?? {}, childNodes: opts.childNodes ?? [] };
}

function textNode(textContent: string): unknown {
  return { type: 3, textContent };
}

test('archive fetcher maps events, metadata console-truth, and offline DOM masked fields into neutral sessions', async (t: TestContext) => {
  const archive = makeArchive(t, {
    name: 'replaytest-archive-adapter',
    console: { console_error_count: 2, console_warn_count: 1, console_log_count: 3 },
  });
  const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment(archive.root, archive.sessionId);

  assert.equal(session.id, SESSION_ID);
  assert.equal(session.distinctId, DISTINCT_ID);
  assert.deepEqual(session.viewport, { width: 1280, height: 720 });
  assert.deepEqual(session.witnessedConsole, { errorCount: 2, warnCount: 1, logCount: 3 });
  assert.deepEqual(session.maskedFields, [{
    label: 'Card number',
    selectorHint: 'input:nth-of-type(2)',
    route: PAY_URL,
    // for="card-number" cannot bind: masking strips the input's id, so the label
    // is only reachable via the sibling path — the provenance flag must be set.
    formKey: 'id:pay-form',
    labelInferredFromAdjacentText: true,
  }]);
});

test('same fixture bytes yield the same named masked field through live-shaped and archive enrichment', async (t: TestContext) => {
  const fixtureEventJsonl = eventJsonl();
  const fixtureBlobLines = snapshotLines();
  const fixtureBlobJsonl = `${fixtureBlobLines.join('\n')}\n`;
  const archive = makeArchive(t, {
    name: 'replaytest-archive-masked-field-parity-present',
    eventJsonl: fixtureEventJsonl,
    blobLines: fixtureBlobLines,
  });

  const liveShaped = enrichLiveShapedFixtureBytes(fixtureEventJsonl, fixtureBlobJsonl);
  const archiveShaped = await fetchArchiveNeutralSessionsWithDomEnrichment(archive.root, archive.sessionId);

  assert.deepEqual(
    archiveShaped.map((session) => session.maskedFields),
    liveShaped.map((session) => session.maskedFields),
  );
  assert.deepEqual(liveShaped[0]?.maskedFields, [
    {
      label: 'Card number',
      selectorHint: 'input:nth-of-type(2)',
      route: PAY_URL,
      formKey: 'id:pay-form',
      labelInferredFromAdjacentText: true,
    },
  ]);
});

test('same fixture bytes leave masked fields absent through both paths when no FullSnapshot covers their route', async (t: TestContext) => {
  const fixtureEventJsonl = eventJsonl();
  const fixtureBlobLines = snapshotLines({ snapshotUrl: DONE_URL, includeMaskedField: false });
  const fixtureBlobJsonl = `${fixtureBlobLines.join('\n')}\n`;
  const archive = makeArchive(t, {
    name: 'replaytest-archive-masked-field-parity-absent',
    eventJsonl: fixtureEventJsonl,
    blobLines: fixtureBlobLines,
  });

  const liveShaped = enrichLiveShapedFixtureBytes(fixtureEventJsonl, fixtureBlobJsonl);
  const archiveShaped = await fetchArchiveNeutralSessionsWithDomEnrichment(archive.root, archive.sessionId);

  assert.deepEqual(
    archiveShaped.map((session) => session.maskedFields),
    liveShaped.map((session) => session.maskedFields),
  );
  assert.deepEqual(liveShaped.map((session) => session.maskedFields), [undefined]);
});

test('archive fetcher refuses a manifest file whose sha256 does not match before decoding blobs', async (t: TestContext) => {
  const archive = makeArchive(t, { name: 'replaytest-archive-sha', corruptBlobHash: true });
  await assert.rejects(
    () => fetchArchiveNeutralSessionsWithDomEnrichment(archive.root, archive.sessionId),
    (err) => err instanceof ArchiveIntegrityError && err.message.includes('failed sha256 verification'),
  );
});

test('archive fetcher reports missing events distinctly from an absent session', async (t: TestContext) => {
  const archive = makeArchive(t, { name: 'replaytest-archive-missing-events', includeEvents: false });
  await assert.rejects(
    () => fetchArchiveNeutralSessionsWithDomEnrichment(archive.root, archive.sessionId),
    (err) => err instanceof ArchiveMissingEventsError && !err.message.includes('No session found'),
  );
});

test('archive DOM enrichment is independent of blob range-file boundaries', async (t: TestContext) => {
  const oneChunk = makeArchive(t, { name: 'replaytest-archive-one-chunk' });
  const splitChunks = makeArchive(t, { name: 'replaytest-archive-split-chunks', splitBlobs: true });

  const fromOneChunk = await fetchArchiveNeutralSessionsWithDomEnrichment(oneChunk.root, oneChunk.sessionId);
  const fromSplitChunks = await fetchArchiveNeutralSessionsWithDomEnrichment(splitChunks.root, splitChunks.sessionId);

  assert.equal(JSON.stringify(fromOneChunk), JSON.stringify(fromSplitChunks));
});

test('archive full-stream reader matches the live decode path on the same blob fixture bytes', (t: TestContext) => {
  const blobLines = fullReplayStreamLines();
  const archive = makeArchive(t, { name: 'replaytest-archive-full-stream', blobLines });

  const livePath = decodeFullReplayStream(blobLines.join('\n')).windows;
  const archivePath = fetchArchiveFullReplayStream(archive.root, archive.sessionId);

  assert.deepEqual(archivePath, livePath);
  assert.deepEqual(archivePath.map(({ window, hasFullSnapshot }) => ({ window, hasFullSnapshot })), [
    { window: 0, hasFullSnapshot: false },
    { window: 1, hasFullSnapshot: true },
    { window: 2, hasFullSnapshot: false },
  ]);
});

test('runPlan --from-archive writes byte-identical plans across repeated reads and does not use live fetch/config deps', async (t: TestContext) => {
  const archive = makeArchive(t, { name: 'replaytest-archive-plan' });
  const plansDirA = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-archive-plan-a-'));
  const plansDirB = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-archive-plan-b-'));
  const logs: string[] = [];
  let liveConfigCalled = false;
  process.exitCode = undefined;

  const deps = {
    plansDir: plansDirA,
    log: (line: string) => logs.push(line),
    getProviderConfigStatus: () => {
      liveConfigCalled = true;
      throw new Error('live config should not be read in archive mode');
    },
    fetchNeutralSessionsWithDomEnrichment: async () => {
      throw new Error('injected live fetcher should not be called in archive mode');
    },
    fetchCoarseSessions: () => {
      throw new Error('sample aggregation should be forced off in archive mode');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('sample member fetch should be forced off in archive mode');
    },
  };

  await runPlan([archive.sessionId, '--from-archive', archive.root], deps);
  await runPlan([archive.sessionId, '--from-archive', archive.root], { ...deps, plansDir: plansDirB });

  const markdownA = fs.readFileSync(path.join(plansDirA, fs.readdirSync(plansDirA).find((file) => file.endsWith('.md')) as string), 'utf8');
  const markdownB = fs.readFileSync(path.join(plansDirB, fs.readdirSync(plansDirB).find((file) => file.endsWith('.md')) as string), 'utf8');
  const jsonA = fs.readFileSync(path.join(plansDirA, fs.readdirSync(plansDirA).find((file) => file.endsWith('.plan.json')) as string), 'utf8');
  const jsonB = fs.readFileSync(path.join(plansDirB, fs.readdirSync(plansDirB).find((file) => file.endsWith('.plan.json')) as string), 'utf8');

  assert.equal(markdownA, markdownB);
  assert.equal(jsonA, jsonB);
  assert.equal(liveConfigCalled, false);
  assert.ok(logs.some((line) => line.includes(`source: file archive (${archive.root}), archived ${formatLocalTime(ARCHIVED_AT)} (UTC: ${ARCHIVED_AT}); single-session`)));
  assert.ok(markdownA.includes(`**Provenance:** source: file archive (${archive.root}), archived ${ARCHIVED_AT}; single-session`));
  assert.equal(jsonA.includes('Aggregated across'), false);
});

test('runPlan --from-archive logs missing-events degradation instead of generic no-session wording', async (t: TestContext) => {
  const archive = makeArchive(t, { name: 'replaytest-archive-plan-missing-events', includeEvents: false });
  const logs: string[] = [];
  process.exitCode = undefined;

  await runPlan([archive.sessionId, '--from-archive', archive.root], {
    plansDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-archive-plan-missing-events-out-')),
    log: (line) => logs.push(line),
  });

  assert.equal(process.exitCode, 1);
  assert.ok(logs.some((line) => line.includes('events file is missing')));
  assert.equal(logs.some((line) => line.includes('No session found')), false);
  process.exitCode = undefined;
});

test('runSessions --from-archive branches through archive fetchers before live config', (t: TestContext) => {
  const archive = makeArchive(t, { name: 'replaytest-archive-sessions' });
  const logs: string[] = [];
  let liveConfigCalled = false;
  process.exitCode = undefined;

  runSessions([archive.sessionId, '--from-archive', archive.root, '--json'], {
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => {
      liveConfigCalled = true;
      throw new Error('live config should not be read in archive sessions mode');
    },
  });

  assert.equal(liveConfigCalled, false);
  assert.equal(process.exitCode, undefined);
  const output = JSON.parse(logs.join('\n')) as { provenance: string; journeys: unknown[] };
  assert.equal(output.provenance, 'exact');
  assert.equal(output.journeys.length, 1);
});

test('runSessions --from-archive leaves the durable completion census untouched', (t: TestContext) => {
  // The census is scan evidence. An archive run REPLAYS a stored recording, so
  // recording its counts as `provenance: "exact"` would be a provenance
  // falsehood — and because this same path runs on every `npm test`, it also
  // evicted real production entries from the bounded 20-entry history.
  const archive = makeArchive(t, { name: 'replaytest-archive-sessions-census' });
  const censusPath = path.resolve(COMPLETION_CENSUS_PATH);
  const before = fs.existsSync(censusPath) ? fs.readFileSync(censusPath, 'utf8') : null;
  process.exitCode = undefined;

  runSessions([archive.sessionId, '--from-archive', archive.root, '--json'], { log: () => {} });

  const after = fs.existsSync(censusPath) ? fs.readFileSync(censusPath, 'utf8') : null;
  assert.equal(after, before, 'an archive scan must not write the workspace completion census');
  process.exitCode = undefined;
});

test('seam guard: provider vocabulary literals stay under src/providers in executable source', () => {
  assert.deepEqual(providerVocabularyLeaks(), []);
});

export function providerVocabularyLeaks(repoSrc = path.resolve('src')): string[] {
  return withSourceSnapshotRetry(() => {
  const allowed = `${path.sep}providers${path.sep}`;
  const providerLiterals = [
    '$event_type',
    '$el_text',
    '$current_url',
    '$session_id',
    '$viewport_width',
    '$viewport_height',
    '$exception',
    '$exception_types',
    'elements_chain',
    'attr__',
    'blob_v2',
    'console_error_count',
    'console_warn_count',
    'console_log_count',
    'session_recordings',
  ];

  const leaks: string[] = [];
  for (const file of sourceFiles(repoSrc)) {
    if (file.includes(allowed)) continue;
    const text = stripComments(readSourceFile(file));
    for (const literal of providerLiterals) {
      if (text.includes(literal)) leaks.push(`${path.relative(process.cwd(), file)}: ${literal}`);
    }
  }
  return leaks;
  });
}

test('transient probe pin: provider vocabulary output is invariant with poison content', () => {
  const baseline = providerVocabularyLeaks();
  const probePath = path.join(process.cwd(), transientProbePath('tmp-fire-probe'));
  try {
    fs.writeFileSync(probePath, "export const transientProbe = { $event_type: true, elements_chain: [] };\n", { flag: 'wx' });
    assert.deepEqual(providerVocabularyLeaks(), baseline);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'P3 probe cleanup must complete');
  }
});

// live-src enumerator: E10
export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && !isTransientProbePath(entry.name) && fullPath.endsWith('.ts')) {
      found.push(fullPath);
    }
  }
  return found;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
