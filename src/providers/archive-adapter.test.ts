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
  fetchArchiveNeutralSessionsLight,
} from './archive-adapter.js';
import {
  OUTCOME_EVIDENCE_CASES,
} from '../test-support/outcome-evidence.test-support.js';
import {
  buildRouteIndex,
  buildRouteTimeline,
  decodeFullReplayStream,
  enrichNeutralSessionWithReplayEvidence,
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
    JSON.stringify([
      'archive-window-earlier',
      {
        type: 3,
        timestamp: 300,
        data: {
          source: 0,
          adds: gzipJson([]),
          attributes: gzipJson([]),
          removes: gzipJson([]),
          texts: gzipJson([{ id: 9, value: 'Archive save failed' }]),
        },
      },
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

test('archive light and DOM-enriched loaders preserve element-chain page-chrome evidence', async (t: TestContext) => {
  const customRows = [
    row({ timestamp: '2026-07-10T02:00:00.000Z', event: '$pageview', url: PAY_URL }),
    row({
      timestamp: '2026-07-10T02:00:01.000Z', event: '$autocapture', event_type: 'change', url: PAY_URL,
      elements_chain: 'input:attr__name="query"nth-child="1"nth-of-type="1";form:attr__id="search"nth-child="1"nth-of-type="1";header:attr__role="search"nth-child="1"nth-of-type="1"',
    }),
    row({
      timestamp: '2026-07-10T02:00:02.000Z', event: '$autocapture', event_type: 'change', url: PAY_URL,
      elements_chain: 'input:attr__name="email"nth-child="1"nth-of-type="1";form:attr__id="pay-form"nth-child="1"nth-of-type="1"',
    }),
  ];
  const archive = makeArchive(t, {
    name: 'replaytest-archive-page-chrome',
    eventJsonl: `${customRows.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  });
  const light = fetchArchiveNeutralSessionsLight(archive.root, archive.sessionId)[0];
  const [deep] = await fetchArchiveNeutralSessionsWithDomEnrichment(archive.root, archive.sessionId);
  assert.ok(light !== undefined && deep !== undefined);
  assert.equal(light.steps[1]?.inPageChrome, true);
  assert.equal(deep.steps[1]?.inPageChrome, true);
  assert.equal(light.steps[2]?.inPageChrome, undefined);
  assert.equal(deep.steps[2]?.inPageChrome, undefined);
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
  const mutation = archivePath[1]?.events.find((event) => (event as { type?: unknown }).type === 3) as
    | { data?: Record<string, unknown> }
    | undefined;
  assert.deepEqual(mutation?.data?.texts, [{ id: 9, value: 'Archive save failed' }]);
  assert.equal(archivePath[1]?.decodeIssues, undefined);
});

test('archive adapter emits the shared real recording facts, including both open-form facts', async () => {
  const cases = OUTCOME_EVIDENCE_CASES.filter((testCase) => testCase.sessionId !== undefined && testCase.derived === undefined);
  const sessions = new Map<string, Awaited<ReturnType<typeof fetchArchiveNeutralSessionsWithDomEnrichment>>[number]>();
  for (const testCase of cases) {
    const sessionId = testCase.sessionId;
    const locator = testCase.locator;
    assert.ok(sessionId !== undefined && locator !== undefined, testCase.name);
    let session = sessions.get(sessionId);
    if (session === undefined) {
      [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', sessionId);
      assert.ok(session !== undefined, `${testCase.name}: session loaded`);
      sessions.set(sessionId, session);
    }
    const matching = session.steps.filter((step) => step.kind === locator.kind && step.url === locator.url);
    const step = matching[locator.nth - 1];
    assert.ok(step !== undefined, `${testCase.name}: locator resolves`);
    if (testCase.value === undefined) throw new Error(`${testCase.name}: expected fixture value is missing`);
    const key = 'afterSubmit' in testCase.value ? 'afterSubmit' : 'landing';
    const expectedRecord = testCase.value as unknown as Record<'afterSubmit' | 'landing', Record<string, unknown>>;
    const expectedValue = expectedRecord[key];
    const actual = (step as unknown as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    assert.ok(actual !== undefined, `${testCase.name}: ${key} is emitted`);
    const projectExpectedKeys = (value: Record<string, unknown>, fixture: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(fixture).map((field) => [field, value[field]]));
    assert.deepEqual(projectExpectedKeys(actual, expectedValue), expectedValue, testCase.name);
    if (step.landing !== undefined) {
      assert.ok('relatedOpenForm' in step.landing && 'unrelatedOpenForm' in step.landing, `${testCase.name}: both open-form facts`);
    }
  }
  assert.equal(sessions.size, 4, 'all four shared real recordings were loaded');
});

test('archive adapter: a Meta page load followed by its own same-URL route marker is one occurrence, so the replay-off visit borrows nothing', async () => {
  // Real shape: each page load carries a Meta, its FullSnapshot, then the
  // page's own route marker with the same href; the second feedback step-2
  // visit was driven with replay off, so nothing in the recording is its own.
  // The recording is found by its id prefix (the full id's digit groups read
  // as a long number to the PII scan; it is an archive session id).
  const sessionIds = fs.readdirSync(path.join('archive', 'recordings')).filter((id) => id.startsWith('019f4a3c-f140-'));
  assert.equal(sessionIds.length, 1, 'exactly one archive recording carries the prefix');
  const sessionId = sessionIds[0] ?? '';
  assert.equal(sessionId.length, 36);
  const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', sessionId);
  assert.ok(session !== undefined);
  const nth = (kind: string, page: string, n: number) =>
    session.steps.filter((step) => step.kind === kind && step.url === `http://localhost:8000/flows/${page}`)[n - 1];
  assert.equal(nth('submit', 'promo-4-step2.html', 1)?.afterSubmit?.coverage, 'covered', 'the recorded visit keeps its own anchor');
  assert.equal(nth('submit', 'feedback-5-step2.html', 1)?.afterSubmit?.coverage, 'covered', 'the recorded feedback visit keeps its own anchor');
  assert.equal(nth('submit', 'feedback-5-step2.html', 2)?.afterSubmit?.coverage, 'no-recording', 'the replay-off visit reads no-recording, never covered');
  assert.equal(nth('navigation', 'feedback-5-step3.html', 2)?.landing?.coverage, 'no-occurrence', 'and its landing was never watched');
});

test('archive adapter: under the lineup rule the eval recordings carry 39 Meta + own-marker pairs, and the coverage counts over all 78 are pinned', async () => {
  // The archive shape the one normalization exists for: a Meta, its own
  // FullSnapshot, then the page's own same-URL route marker 1-3 ms later,
  // with no click, input or submit between. Counted here independently of
  // the adapter, straight from the decoded windows.
  // The eval set comes from its tracked list, never from the recordings
  // folder: that folder is gitignored, and a dev checkout holds the whole
  // private corpus beside the 78.
  const ids = fs.readFileSync(path.join('archive', 'eval-set.ids'), 'utf8')
    .split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')).sort();
  assert.equal(ids.length, 78);
  // The list is the source here, so it is checked against the folders it names: every listed id
  // has a recordings folder and a goldens folder, and the tracked goldens folders are exactly the
  // listed ids (a list that drifts from either folder fails here, not in the counts below).
  const isFolder = (...parts: string[]) => fs.existsSync(path.join(...parts)) && fs.statSync(path.join(...parts)).isDirectory();
  assert.deepEqual(ids.filter((id) => !isFolder('archive', 'recordings', id)), [], 'every listed id has a recordings folder');
  assert.deepEqual(ids.filter((id) => !isFolder('archive', 'goldens', id)), [], 'every listed id has a goldens folder');
  const goldenFolders = fs.readdirSync(path.join('archive', 'goldens'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.equal(goldenFolders.length, ids.length, 'one goldens folder per listed id');
  assert.deepEqual(goldenFolders, ids, 'the goldens folders are exactly the listed ids');
  const keyOf = (href: unknown) => {
    if (typeof href !== 'string') return undefined;
    const parsed = new URL(href);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  };
  let pairs = 0;
  const pairRecordings = new Set<string>();
  const gaps: number[] = [];
  for (const id of ids) {
    for (const window of fetchArchiveFullReplayStream('archive', id)) {
      let meta: { key?: string; at: number; snapshots: number } | undefined;
      for (const raw of window.events) {
        const event = raw as { type?: number; timestamp?: number; data?: Record<string, unknown> };
        const custom = event.type === 5 && event.data?.tag === '$pageview';
        if (event.type === 4 || custom) {
          const href = event.type === 4 ? event.data?.href : (event.data?.payload as { href?: unknown } | undefined)?.href;
          if (custom && meta !== undefined && meta.snapshots <= 1 && keyOf(href) === meta.key && (event.timestamp ?? 0) - meta.at <= 1_000) {
            pairs += 1;
            pairRecordings.add(id);
            gaps.push((event.timestamp ?? 0) - meta.at);
          }
          meta = event.type === 4 ? { key: keyOf(href), at: event.timestamp ?? 0, snapshots: 0 } : undefined;
          continue;
        }
        if (meta === undefined) continue;
        const data = event.data ?? {};
        const interaction = (event.type === 3 && ((data.source === 2 && data.type === 2) || data.source === 5))
          || (event.type === 5 && (data.payload as { event_type?: unknown } | undefined)?.event_type === 'submit');
        if (interaction) meta = undefined;
        else if (event.type === 2) meta.snapshots += 1;
      }
    }
  }
  assert.equal(pairs, 39, 'Meta + own-marker pairs in the eval recordings');
  assert.equal(pairRecordings.size, 19);
  assert.ok(gaps.every((gap) => gap >= 1 && gap <= 3), 'every pair is 1-3 ms apart');

  // Coverage over every submit and landing of the 78 recordings. Against the
  // order join before the lineup rule, the rows of one recording with a
  // doubled event stream fell to the unbound fallthrough values; the two
  // recordings that open on a page the events never carry bind again once
  // that head page is trimmed, with the order join's facts.
  const tally: Record<string, number> = {};
  for (const id of ids) {
    for (const session of await fetchArchiveNeutralSessionsWithDomEnrichment('archive', id)) {
      for (const step of session.steps) {
        const key = step.kind === 'submit' ? `submit:${step.afterSubmit?.coverage}` : step.kind === 'navigation' ? `landing:${step.landing?.coverage}` : undefined;
        if (key !== undefined) tally[key] = (tally[key] ?? 0) + 1;
      }
    }
  }
  assert.deepEqual(tally, {
    'landing:clipped': 165, 'landing:no-occurrence': 83, 'landing:seen-unsettled': 67, 'landing:settled': 23,
    'submit:clipped': 15, 'submit:covered': 105, 'submit:no-anchor': 1, 'submit:no-recording': 18,
  });
});

test('archive adapter emits the shared promo-1 boundary twin after a fourth counted field is added in memory', async () => {
  const fixture = OUTCOME_EVIDENCE_CASES.find((testCase) => testCase.name === 'promo-1 step 2 boundary twin, one more filled control');
  if (fixture?.sessionId === undefined || fixture.locator === undefined || fixture.value === undefined || !('landing' in fixture.value)) {
    throw new Error('shared promo-1 boundary fixture is incomplete');
  }
  const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', fixture.sessionId);
  assert.ok(session !== undefined);
  const windows = structuredClone(fetchArchiveFullReplayStream('archive', fixture.sessionId));
  let changed = false;
  for (const window of windows) for (const event of window.events) {
    const record = event as { type?: unknown; data?: Record<string, unknown> };
    if (record.type !== 3 || !Array.isArray(record.data?.adds)) continue;
    const adds = record.data.adds as Array<{ parentId?: unknown; node?: Record<string, unknown> }>;
    const example = adds.find((add) => add.node?.tagName === 'input' && add.node.attributes !== undefined);
    const form = adds.find((add) => add.node?.tagName === 'form');
    if (example?.node === undefined || form?.node === undefined || typeof form.node.id !== 'number') continue;
    const copied = structuredClone(example.node);
    copied.id = 100_001;
    const attrs = copied.attributes as Record<string, unknown>;
    attrs.id = 'promo-1-s2-f3';
    attrs.name = 'extra-prefilled';
    attrs.type = 'text';
    attrs.value = 'filled';
    adds.push({ parentId: form.node.id, node: copied });
    changed = true;
    break;
  }
  assert.equal(changed, true, 'a captured step-2 form and input shape were found');
  const decoded = { windows, malformedLinesSkipped: 0 };
  const loaded = enrichNeutralSessionWithReplayEvidence(session, decoded, true).session;
  const matching = loaded.steps.filter((step) => step.kind === fixture.locator?.kind && step.url === fixture.locator.url);
  const actual = matching[fixture.locator.nth - 1]?.landing;
  assert.ok(actual !== undefined);
  assert.equal(actual.coverage, fixture.value.landing.coverage);
  assert.equal(actual.relatedOpenForm, fixture.value.landing.relatedOpenForm);
  assert.equal(actual.unrelatedOpenForm, fixture.value.landing.unrelatedOpenForm);
});

test('archive adapter emits the shared in-memory dialog twins and truncated replay twins', async () => {
  const realDialog = OUTCOME_EVIDENCE_CASES.find((testCase) => testCase.name === 'create customer with a confirm dialog (real)');
  const dialogTwin = OUTCOME_EVIDENCE_CASES.find((testCase) => testCase.name === 'create customer, dialog twin with an error class on the dialog text');
  const rolelessTwin = OUTCOME_EVIDENCE_CASES.find((testCase) => testCase.name === 'create customer, role-less dialog twin');
  assert.ok(realDialog?.sessionId && dialogTwin?.sessionId && rolelessTwin?.sessionId);
  const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', realDialog.sessionId);
  assert.ok(session !== undefined);
  const windows = fetchArchiveFullReplayStream('archive', realDialog.sessionId);
  const addedNodes = new Map<number, { parentId?: number; tag?: string; attributes?: Record<string, unknown> }>();
  for (const window of windows) for (const event of window.events) {
    const data = (event as { data?: Record<string, unknown> }).data;
    if (!Array.isArray(data?.adds)) continue;
    for (const rawAdd of data.adds) {
      if (typeof rawAdd !== 'object' || rawAdd === null) continue;
      const add = rawAdd as { parentId?: unknown; node?: Record<string, unknown> };
      const node = add.node;
      if (typeof node?.id !== 'number') continue;
      addedNodes.set(node.id, {
        ...(typeof add.parentId === 'number' ? { parentId: add.parentId } : {}),
        ...(typeof node.tagName === 'string' ? { tag: node.tagName.toLowerCase() } : {}),
        ...(typeof node.attributes === 'object' && node.attributes !== null ? { attributes: node.attributes as Record<string, unknown> } : {}),
      });
    }
  }
  const dialogIds = new Set<number>();
  for (const [id, node] of addedNodes) {
    if (node.attributes?.role === 'dialog' || node.attributes?.role === 'alertdialog') dialogIds.add(id);
  }
  const dialogTextIds = new Set<number>();
  for (const [id, node] of addedNodes) {
    if (node.tag !== 'p') continue;
    let parentId = node.parentId;
    while (parentId !== undefined) {
      if (dialogIds.has(parentId)) { dialogTextIds.add(id); break; }
      parentId = addedNodes.get(parentId)?.parentId;
    }
  }
  const mutateDialog = (removeRole: boolean) => structuredClone(windows).map((window) => ({
    ...window,
    events: window.events.map((event) => {
      const clone = structuredClone(event) as Record<string, unknown>;
      const data = clone.data as Record<string, unknown> | undefined;
      if (Array.isArray(data?.adds)) for (const rawAdd of data.adds) {
        if (typeof rawAdd !== 'object' || rawAdd === null) continue;
        const add = rawAdd as { node?: Record<string, unknown> };
        if (typeof add.node?.id !== 'number') continue;
        const attrs = add.node.attributes as Record<string, unknown> | undefined;
        if (attrs === undefined) continue;
        if (dialogTextIds.has(add.node.id)) attrs.class = 'text-danger';
        if (removeRole && dialogIds.has(add.node.id)) delete attrs.role;
      }
      return clone;
    }),
  }));
  const locate = (name: string) => {
    const testCase = OUTCOME_EVIDENCE_CASES.find((candidate) => candidate.name === name);
    if (testCase?.locator === undefined || testCase.value === undefined || !('afterSubmit' in testCase.value)) {
      throw new Error(`${name}: shared after-submit fixture is incomplete`);
    }
    return { fixtureValue: testCase.value.afterSubmit, index: session.steps.findIndex((step, index) => {
      const matching = session.steps.filter((candidate) => candidate.kind === testCase.locator?.kind && candidate.url === testCase.locator?.url);
      return step === matching[testCase.locator!.nth - 1] && index >= 0;
    }) };
  };
  const assertCase = (name: string, decode = windows) => {
    const { fixtureValue, index } = locate(name);
    assert.ok(index >= 0);
    const actual = enrichNeutralSessionWithReplayEvidence(session, { windows: decode, malformedLinesSkipped: 0 }, true).session.steps[index]?.afterSubmit;
    assert.ok(actual !== undefined);
    assert.deepEqual(Object.fromEntries(Object.keys(fixtureValue).map((key) => [key, actual[key as keyof typeof actual]])), fixtureValue, name);
  };
  assertCase(realDialog.name);
  assertCase(dialogTwin.name, mutateDialog(false));
  assertCase(rolelessTwin.name, mutateDialog(true));

  for (const name of ['refused promo code, truncated twin', 'refused promo-3 step, truncated twin']) {
    const fixture = OUTCOME_EVIDENCE_CASES.find((candidate) => candidate.name === name);
    if (fixture?.sessionId === undefined || fixture.locator === undefined || fixture.value === undefined || !('afterSubmit' in fixture.value)) {
      throw new Error(`${name}: shared truncated fixture is incomplete`);
    }
    const [fixtureSession] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', fixture.sessionId);
    assert.ok(fixtureSession !== undefined);
    const raw = fetchArchiveFullReplayStream('archive', fixture.sessionId);
    let targetWindow = -1;
    let targetEnd = -1;
    const submitIds = new Set<number>();
    const snapshotNodes = new Map<number, { parentId?: number; tag?: string; attrs?: Record<string, unknown> }>();
    const collectTree = (value: unknown, parentId?: number): void => {
      if (Array.isArray(value)) { for (const child of value) collectTree(child, parentId); return; }
      if (typeof value !== 'object' || value === null) return;
      const node = value as Record<string, unknown>;
      if (typeof node.id !== 'number' || typeof node.type !== 'number') return;
      const attrs = typeof node.attributes === 'object' && node.attributes !== null ? node.attributes as Record<string, unknown> : {};
      const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : undefined;
      snapshotNodes.set(node.id, { ...(parentId === undefined ? {} : { parentId }), ...(tag === undefined ? {} : { tag }), attrs });
      if (tag === 'button' && (attrs.type === undefined || attrs.type === 'submit') || tag === 'input' && (attrs.type === 'submit' || attrs.type === 'image')) {
        let currentParent = parentId;
        while (currentParent !== undefined) {
          if (snapshotNodes.get(currentParent)?.tag === 'form' || typeof attrs.form === 'string') { submitIds.add(node.id); break; }
          currentParent = snapshotNodes.get(currentParent)?.parentId;
        }
      }
      if (Array.isArray(node.childNodes)) for (const child of node.childNodes) collectTree(child, node.id);
    };
    for (const window of raw) for (const event of window.events) {
      const e = event as { type?: unknown; data?: Record<string, unknown> };
      if (e.type === 2 && typeof e.data?.node === 'object') collectTree(e.data.node);
    }
    for (let windowIndex = 0; windowIndex < raw.length; windowIndex += 1) {
      const events = raw[windowIndex]?.events ?? [];
      let occurrenceUrl: string | undefined;
      let lastClick = -1;
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex] as { type?: unknown; data?: Record<string, unknown> };
        if (event.type === 4 && typeof event.data?.href === 'string') occurrenceUrl = event.data.href;
        if (event.type === 5 && typeof event.data?.payload === 'object' && event.data.payload !== null) {
          const payload = event.data.payload as Record<string, unknown>;
          if (typeof payload.href === 'string') occurrenceUrl = payload.href;
        }
        if (occurrenceUrl === fixture.locator.url && event.type === 3 && event.data?.source === 2 && event.data.type === 2 &&
            typeof event.data.id === 'number' && submitIds.has(event.data.id)) {
          targetWindow = windowIndex;
          lastClick = eventIndex;
        }
      }
      if (lastClick >= 0 && windowIndex === targetWindow) targetEnd = lastClick;
    }
    assert.ok(targetWindow >= 0 && targetEnd >= 0, `${name}: recording anchor click found by page occurrence`);
    const truncated = structuredClone(raw);
    const selected = truncated[targetWindow];
    assert.ok(selected !== undefined);
    selected.events = selected.events.slice(0, targetEnd + 1);
    truncated.splice(targetWindow + 1);
    const stepIndex = fixtureSession.steps.findIndex((step, index) => {
      const matches = fixtureSession.steps.filter((candidate) => candidate.kind === fixture.locator?.kind && candidate.url === fixture.locator?.url);
      return step === matches[fixture.locator!.nth - 1] && index >= 0;
    });
    const actual = enrichNeutralSessionWithReplayEvidence(fixtureSession, { windows: truncated, malformedLinesSkipped: 0 }, true).session.steps[stepIndex]?.afterSubmit;
    assert.ok(actual !== undefined);
    assert.deepEqual(Object.fromEntries(Object.keys(fixture.value.afterSubmit).map((key) => [key, actual[key as keyof typeof actual]])), fixture.value.afterSubmit, name);
  }
});

test('known residual: an app that clears its error just before redirecting', async () => {
  const fixture = OUTCOME_EVIDENCE_CASES.find((testCase) => testCase.name === 'create customer with a confirm dialog (real)');
  if (fixture?.sessionId === undefined || fixture.locator === undefined) throw new Error('real redirect fixture is incomplete');
  const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', fixture.sessionId);
  assert.ok(session !== undefined);
  const windows = structuredClone(fetchArchiveFullReplayStream('archive', fixture.sessionId));
  const window = windows[0];
  assert.ok(window !== undefined);
  const events = window.events as Array<Record<string, unknown>>;
  const routeUrl = (event: Record<string, unknown>): string | undefined => {
    const data = event.data;
    if (event.type === 4 && typeof data === 'object' && data !== null) {
      const href = (data as Record<string, unknown>).href;
      return typeof href === 'string' ? href : undefined;
    }
    if (event.type === 5 && typeof data === 'object' && data !== null) {
      const value = data as Record<string, unknown>;
      const payload = value.payload;
      if (value.tag === '$pageview' && typeof payload === 'object' && payload !== null) {
        const href = (payload as Record<string, unknown>).href;
        return typeof href === 'string' ? href : undefined;
      }
    }
    return undefined;
  };
  const occurrenceStart = events.findIndex((event) => routeUrl(event)?.endsWith('/customers/new'));
  const routeIndex = events.findIndex((event, index) => index > occurrenceStart && routeUrl(event)?.endsWith('/customers/cust-6'));
  assert.ok(occurrenceStart >= 0 && routeIndex > occurrenceStart, 'the real new-customer occurrence and next route marker are present');

  const live = new Map<number, { tag: string; attrs: Record<string, unknown>; parentId?: number }>();
  const collectNode = (value: unknown, parentId?: number): void => {
    if (Array.isArray(value)) { for (const child of value) collectNode(child, parentId); return; }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.id !== 'number' || typeof node.type !== 'number') return;
    const attrs = typeof node.attributes === 'object' && node.attributes !== null ? node.attributes as Record<string, unknown> : {};
    const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
    live.set(node.id, { tag, attrs, ...(parentId === undefined ? {} : { parentId }) });
    if (Array.isArray(node.childNodes)) for (const child of node.childNodes) collectNode(child, node.id);
  };
  const isSubmitButton = (id: number): boolean => {
    const node = live.get(id);
    if (node === undefined || node.tag !== 'button') return false;
    const type = typeof node.attrs.type === 'string' ? node.attrs.type.toLowerCase() : '';
    if (type !== '' && type !== 'submit') return false;
    let parentId = node.parentId;
    while (parentId !== undefined) {
      if (live.get(parentId)?.tag === 'form') return true;
      parentId = live.get(parentId)?.parentId;
    }
    return false;
  };
  let anchorIndex = -1;
  let overlayId: number | undefined;
  let overlayAddIndex = -1;
  let overlayRemoveIndex = -1;
  let routeTimestamp = -1;
  let removalTimestamp = -1;
  let anchorTimestamp = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {};
    if (event.type === 2) {
      live.clear();
      collectNode(data.node);
    } else if (event.type === 3 && data.source === 0) {
      const removes = Array.isArray(data.removes) ? data.removes as Array<Record<string, unknown>> : [];
      if (overlayId !== undefined && removes.some((remove) => remove.id === overlayId)) {
        overlayRemoveIndex = index;
        removalTimestamp = typeof event.timestamp === 'number' ? event.timestamp : -1;
      }
      const adds = Array.isArray(data.adds) ? data.adds as Array<Record<string, unknown>> : [];
      for (const add of adds) {
        const node = add.node;
        if (typeof node === 'object' && node !== null) {
          const value = node as Record<string, unknown>;
          const attrs = typeof value.attributes === 'object' && value.attributes !== null ? value.attributes as Record<string, unknown> : {};
          if (value.tagName === 'div' && attrs.class === 'modal-overlay' && typeof value.id === 'number') {
            overlayId = value.id;
            overlayAddIndex = index;
          }
          collectNode(node, typeof add.parentId === 'number' ? add.parentId : undefined);
        }
      }
    }
    if (event.type === 3 && data.source === 2 && data.type === 2 && typeof data.id === 'number' && isSubmitButton(data.id) && index > occurrenceStart && index < routeIndex) {
      anchorIndex = index;
      anchorTimestamp = typeof event.timestamp === 'number' ? event.timestamp : -1;
    }
    if (index === routeIndex) routeTimestamp = typeof event.timestamp === 'number' ? event.timestamp : -1;
  }
  assert.ok(anchorIndex >= 0 && overlayAddIndex > anchorIndex && overlayRemoveIndex > overlayAddIndex && routeIndex > overlayRemoveIndex,
    'the real submit anchor, overlay addition/removal, and route marker occur in order');
  assert.equal(routeTimestamp - removalTimestamp, 9, 'the real overlay is removed 9 ms before the next route marker');

  const overlayAddEvent = events[overlayAddIndex];
  const overlayData = overlayAddEvent?.data as Record<string, unknown>;
  const overlayAdds = overlayData.adds as Array<Record<string, unknown>>;
  const realMessage = overlayAdds.find((add) => (add.node as Record<string, unknown> | undefined)?.tagName === 'p');
  assert.ok(realMessage?.node !== undefined, 'the real dialog message node supplies the derived rrweb tree shape');
  const message = structuredClone(realMessage.node) as Record<string, unknown>;
  let nextId = 30_000;
  const rekeyTree = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) rekeyTree(child); return; }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.id === 'number') node.id = nextId++;
    if (Array.isArray(node.childNodes)) for (const child of node.childNodes) rekeyTree(child);
  };
  rekeyTree(message);
  const messageAttrs = message.attributes as Record<string, unknown>;
  messageAttrs.class = 'error';
  overlayAdds.push({ parentId: overlayId, node: message });
  window.events = events.filter((event, index) => {
    if (index <= anchorIndex || index >= routeIndex || event.type !== 3) return true;
    const data = event.data as Record<string, unknown> | undefined;
    return !(data?.source === 2 && data.type === 2);
  });
  const gapMs = routeTimestamp - anchorTimestamp;
  const step = session.steps.filter((value) => value.kind === fixture.locator?.kind && value.url === fixture.locator?.url)[fixture.locator.nth - 1];
  assert.ok(step !== undefined);
  const result = enrichNeutralSessionWithReplayEvidence(session, { windows, malformedLinesSkipped: 0 }, true).session;
  const actual = result.steps[session.steps.indexOf(step)]?.afterSubmit;
  assert.deepEqual(actual, {
    coverage: 'covered', windowMs: gapMs, formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [], goneAtPageChange: 1,
  });
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
