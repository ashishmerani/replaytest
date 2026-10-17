import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMPLETION_EVIDENCE_LADDER } from '../../src/completion-evidence.js';
import {
  appendSessionsCoverage,
  appendSessionsGapsOnly,
  appendSessionsPlanReviewDisclosure,
  appendSessionsReplayContract,
  appendSessionsSemanticsDisclosure,
  appendSessionsShapeFilter,
  appendSessionsSupersededPlansDisclosure,
  explainJsonFixtureEnvelopes,
  formatFamiliesJson,
  formatGapsJson,
  formatPreflightRefusalJson,
  formatScanStatusJson,
  formatSessionsJson,
  formatStoredSessionsJson,
  formatSuiteHealthJson,
  formatSuiteStatusOutput,
  preflightJsonEnvelope,
} from '../../src/cli.js';
import { formatAcceptJson, formatAcceptRefusalJson } from '../../src/accept.js';
import { formatFixSelectorJson } from '../../src/cli/verbs/fix-selector.js';
import { formatRetireEvidenceViewJson, formatRetireRefusalJson, formatRetireResultJson } from '../../src/cli/verbs/retire.js';
import { doctorJsonEnvelope, formatDoctorRefusalJson } from '../../src/doctor.js';
import { healJsonEnvelope } from '../../src/heal.js';
import {
  formatRegenerateJson,
  formatRegenerateRefusalJson,
  type RegenerateRefusal,
  type RegenerateResult,
  type RegenerateSearch,
} from '../../src/regenerate.js';
import { suiteStatusJsonEnvelope } from '../../src/suite-status.js';
import { CLI_VERBS } from '../../src/artifact-registry.js';
import { formatDiffJson, formatDiffRefusalJson, formatTriageRefusalJson, triageJsonEnvelope, type SidecarDiff } from '../../src/triage.js';
import {
  compareVersions,
  NODE_ENGINES_RANGE,
  NODE_REQUIREMENT_COMPAT_CLAIM,
  NODE_VERIFIED_NOTE,
  PLAYWRIGHT_COMPAT_CLAIM,
  PLAYWRIGHT_FLOOR,
  PLAYWRIGHT_VERIFIED_AT,
  POSTHOG_CLI_COMPAT_CLAIM,
  POSTHOG_INSTRUMENTATION_COMPAT_NOTE,
  POSTHOG_SERVICE_COMPAT_CLAIM,
  POSTHOG_CLI_VERIFIED_VERSIONS,
  VERSION_COMPATIBILITY_POLICY,
  posthogCliKnownGoodRange,
} from '../../src/version-compat.js';
import { CLI_FIXTURES_DIRECTORY, generateCliFixtureOutputs, SAFE_CLI_FIXTURES } from './generate.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const docsSiteDirectory = path.join(repoRoot, 'docs', 'site');
const scannerSamplePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-blocks.md');

export interface FixtureBlock {
  fixtureName: string;
  content: string;
  line: number;
}

/**
 * Parses the exact fixture-block contract used by the customer docs. Content
 * is sliced directly from the markdown, so newline style and trailing bytes
 * remain visible to the byte-for-byte comparison.
 */
export function scanFixtureBlocks(markdown: string, sourcePath: string): FixtureBlock[] {
  const blocks: FixtureBlock[] = [];
  const openingMarker = /<!-- fixture:([a-z0-9]+(?:-[a-z0-9]+)*) -->/g;

  for (let match = openingMarker.exec(markdown); match !== null; match = openingMarker.exec(markdown)) {
    const markerEnd = match.index + match[0].length;
    const openingFence = markdown.startsWith('\r\n```text\r\n', markerEnd)
      ? '\r\n```text\r\n'
      : markdown.startsWith('\n```text\n', markerEnd)
        ? '\n```text\n'
        : undefined;
    if (openingFence === undefined) {
      throw new Error(`${sourcePath}:${lineNumber(markdown, match.index)} has a fixture marker without its required text fence`);
    }

    const contentStart = markerEnd + openingFence.length;
    const closingFence = /^```\r?\n<!-- \/fixture -->/gm;
    closingFence.lastIndex = contentStart;
    const close = closingFence.exec(markdown);
    if (close === null) {
      throw new Error(`${sourcePath}:${lineNumber(markdown, match.index)} has an unterminated fixture block`);
    }

    blocks.push({
      fixtureName: match[1],
      content: markdown.slice(contentStart, close.index),
      line: lineNumber(markdown, match.index),
    });
    openingMarker.lastIndex = close.index + close[0].length;
  }

  return blocks;
}

function lineNumber(value: string, index: number): number {
  return value.slice(0, index).split(/\r?\n/).length;
}

function findMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
    }
  };
  walk(directory);
  return files.sort();
}

function allFixtureBlocks(markdownFiles: readonly string[]): Array<FixtureBlock & { markdownPath: string }> {
  return markdownFiles.flatMap((markdownPath) =>
    scanFixtureBlocks(fs.readFileSync(markdownPath, 'utf8'), path.relative(repoRoot, markdownPath)).map((block) => ({
      ...block,
      markdownPath,
    })),
  );
}

const COMPATIBILITY_RESTAMP_HINT = 'restamp the Compatibility matrix from the constants in src/version-compat.ts';

function compatibilityRow(markdown: string, component: string, sourcePath: string): string {
  const row = markdown.split(/\r?\n/).find((line) => line.startsWith(`| ${component} |`));
  assert.ok(row !== undefined, `${sourcePath} is missing the Compatibility row for ${component}; ${COMPATIBILITY_RESTAMP_HINT}`);
  return row;
}

function nodeMajorClaims(value: string): string[] {
  const ltsByMajor = new Map<string, boolean>();
  for (const match of value.matchAll(/\bNode(?:\.js)?\s+(\d+)(?:\s+(LTS))?\b/g)) {
    const major = match[1]!;
    ltsByMajor.set(major, ltsByMajor.get(major) === true || match[2] === 'LTS');
  }
  return [...ltsByMajor.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([major, isLts]) => `${major}${isLts ? ':lts' : ''}`);
}

function versionLikeStrings(value: string): string[] {
  return [...new Set([...value.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((match) => match[0]))];
}

function sortVersions(versions: readonly string[]): string[] {
  return [...versions].sort((left, right) => compareVersions(left, right) ?? left.localeCompare(right));
}

export function assertClaimVersionList(claim: string, verifiedVersions: readonly string[], claimName: string): void {
  assert.deepEqual(
    sortVersions(versionLikeStrings(claim)),
    sortVersions(verifiedVersions),
    `${claimName} must list every and only verified version; ordering is ignored; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
}

/** Ensures the customer compatibility matrix is stamped from version-compat.ts, not maintained as loose prose. */
export function assertCompatibilityDocs(markdown: string, sourcePath: string): void {
  const nodeRequirement = markdown.split(/\r?\n/).find((line) => line.startsWith('- **Node.js'));
  assert.equal(
    nodeRequirement,
    `- ${NODE_REQUIREMENT_COMPAT_CLAIM}`,
    `${sourcePath} has a stale Node.js Requirements bullet; use the guarded compatibility matrix instead of a hand-copied version; ${COMPATIBILITY_RESTAMP_HINT}`,
  );

  const playwrightRow = compatibilityRow(markdown, '`@playwright/test`', sourcePath);
  assertClaimVersionList(PLAYWRIGHT_COMPAT_CLAIM, PLAYWRIGHT_VERIFIED_AT, 'PLAYWRIGHT_COMPAT_CLAIM');
  const expectedPlaywrightRow =
    `| \`@playwright/test\` | Floor \`>=${PLAYWRIGHT_FLOOR}\` (optional peer); ${PLAYWRIGHT_COMPAT_CLAIM} |`;
  assert.equal(
    playwrightRow,
    expectedPlaywrightRow,
    `${sourcePath} has a stale or overclaimed @playwright/test compatibility row; ${COMPATIBILITY_RESTAMP_HINT}`,
  );

  const nodeRow = compatibilityRow(markdown, 'Node.js', sourcePath);
  assert.ok(
    nodeRow.includes(`\`engines ${NODE_ENGINES_RANGE}\``),
    `${sourcePath} has a stale Node engines range; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
  const verifiedNodeMajors = nodeMajorClaims(NODE_VERIFIED_NOTE);
  assert.ok(verifiedNodeMajors.length > 0, `NODE_VERIFIED_NOTE must name at least one verified Node major; ${COMPATIBILITY_RESTAMP_HINT}`);
  const documentedNodeMajors = nodeMajorClaims(nodeRow);
  assert.deepEqual(
    documentedNodeMajors,
    verifiedNodeMajors,
    `${sourcePath} has stale or overclaimed verified Node majors; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
  const verificationEvidence = /\(([^()]+)\)$/.exec(NODE_VERIFIED_NOTE)?.[1];
  assert.ok(
    verificationEvidence !== undefined,
    `NODE_VERIFIED_NOTE must state what verification ran; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
  assert.ok(
    nodeRow.includes(verificationEvidence),
    `${sourcePath} is missing the Node verification evidence; ${COMPATIBILITY_RESTAMP_HINT}`,
  );

  const latestPosthogCliVersion = posthogCliKnownGoodRange().max;
  const posthogCliRow = compatibilityRow(markdown, 'PostHog CLI', sourcePath);
  assertClaimVersionList(POSTHOG_CLI_COMPAT_CLAIM, POSTHOG_CLI_VERIFIED_VERSIONS, 'POSTHOG_CLI_COMPAT_CLAIM');
  const expectedPosthogCliRow = `| PostHog CLI | ${POSTHOG_CLI_COMPAT_CLAIM} |`;
  assert.equal(
    posthogCliRow,
    expectedPosthogCliRow,
    `${sourcePath} has a stale or overclaimed PostHog CLI compatibility row; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
  assert.ok(
    markdown.includes(`npm install -g @posthog/cli@${latestPosthogCliVersion}`),
    `${sourcePath} has a stale pinned PostHog CLI install command; ${COMPATIBILITY_RESTAMP_HINT}`,
  );

  const posthogServiceRow = compatibilityRow(markdown, 'PostHog', sourcePath);
  assert.equal(
    posthogServiceRow,
    `| PostHog | ${POSTHOG_SERVICE_COMPAT_CLAIM} |`,
    `${sourcePath} has a stale or missing PostHog service compatibility row; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
  assert.ok(
    markdown.includes(VERSION_COMPATIBILITY_POLICY),
    `${sourcePath} is missing or has changed the verified-version policy sentence; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
  assert.ok(
    markdown.includes(POSTHOG_INSTRUMENTATION_COMPAT_NOTE),
    `${sourcePath} is missing or has changed the PostHog instrumentation-honesty sentence; ${COMPATIBILITY_RESTAMP_HINT}`,
  );
}

test('the compatibility restamp hint names a file that ships and points at no unnamed document', () => {
  assert.ok(fs.existsSync(path.join(repoRoot, 'src', 'version-compat.ts')), 'the file the hint names must exist');
  assert.ok(COMPATIBILITY_RESTAMP_HINT.includes('src/version-compat.ts'), 'the hint must name its source of truth by path');
  assert.doesNotMatch(COMPATIBILITY_RESTAMP_HINT, /guide|instructions|playbook/i);
});

test('Quickstart Compatibility matrix matches version-compat constants', () => {
  // The compatibility matrix lives only on the quickstart page; the README links to it.
  const relativePath = 'docs/site/quickstart.md';
  assertCompatibilityDocs(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'), relativePath);
});

test('Tier-1 concepts documentation keeps title and page text as renderings of one assertion type', () => {
  const concepts = fs.readFileSync(path.join(docsSiteDirectory, 'concepts.md'), 'utf8');
  assert.match(concepts, /exactly three conceptual assertion types/);
  assert.match(concepts, /getByText\(\.\.\.\)\.toBeVisible\(\).*toHaveTitle/s);
  assert.match(concepts, /same conceptual assertion type, not additional assertion types/);
});

test('Node compatibility guard accepts order and Node.js spelling, but rejects an extra major', () => {
  const quickstart = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'quickstart.md'), 'utf8');
  const currentClaim = 'verified on Node 22 LTS and Node 24 (full test suite + a packaged-install consumer check).';
  const reorderedClaim = 'verified on Node.js 24 and Node.js 22 LTS (full test suite + a packaged-install consumer check).';
  assert.doesNotThrow(() => assertCompatibilityDocs(quickstart.replace(currentClaim, reorderedClaim), 'reordered-node-major'));

  const overclaimed = 'verified on Node 22 LTS, Node 24, and Node 26 (full test suite + a packaged-install consumer check).';
  assert.throws(
    () => assertCompatibilityDocs(quickstart.replace(currentClaim, overclaimed), 'overclaimed-node-major'),
    /stale or overclaimed verified Node majors/,
  );
});

test('compatibility version-list guard ignores ordering and names that rule on mismatch', () => {
  // A synthetic two-entry list, deliberately NOT the live PLAYWRIGHT_VERIFIED_AT: this test pins the
  // guard's ordering rule and its mismatch wording, so its fixture must not move every time a real
  // version is verified (the live docs↔constants agreement has its own test above).
  const verified: readonly string[] = ['1.30.0', '1.61.0'];
  assert.doesNotThrow(() =>
    assertClaimVersionList('verified at 1.61.0 and 1.30.0; between = expected but untested.', verified, 'test claim'),
  );
  assert.throws(
    () => assertClaimVersionList('verified at 1.61.0; between = expected but untested.', verified, 'test claim'),
    /ordering is ignored/,
  );
});

/**
 * The full command list, derived from the top-level `--help` fixture the
 * fixtures harness already keeps byte-for-byte honest against the live CLI
 * (see `generateCliFixtureOutputs`). Parsing the real synopsis — rather than a
 * hand-kept list — is what makes the routing-table parity guard un-rottable: a
 * new or renamed verb changes `--help`, which the staleness test forces back
 * into `cli-help.txt`, which this reader then requires a routing-table row for.
 */
function cliCommandsFromHelpFixture(): string[] {
  const helpText = fs.readFileSync(path.join(CLI_FIXTURES_DIRECTORY, 'cli-help.txt'), 'utf8');
  const commands = new Set<string>();
  const usageLine = /^ {2}replaytest ([a-z][a-z0-9-]*)/gm;
  for (let match = usageLine.exec(helpText); match !== null; match = usageLine.exec(helpText)) {
    commands.add(match[1]);
  }
  return [...commands].sort();
}

/**
 * Every command whose top-level `--help` usage line advertises `[--json]`.
 * Derived from the SAME byte-honest `cli-help.txt` the command list comes from
 * (see `cliCommandsFromHelpFixture`), so the JSON-capable set can't drift from
 * the CLI without the staleness test forcing the change back into the fixture
 * first — the identical un-rottable property the routing-table guard relies on,
 * now applied to the Part 2 `--json` capability map.
 */
function jsonCapableCommandsFromHelpFixture(): string[] {
  const helpText = fs.readFileSync(path.join(CLI_FIXTURES_DIRECTORY, 'cli-help.txt'), 'utf8');
  const commands = new Set<string>();
  const usageLine = /^ {2}replaytest ([a-z][a-z0-9-]*)([^\n]*)$/gm;
  for (let match = usageLine.exec(helpText); match !== null; match = usageLine.exec(helpText)) {
    if (match[2].includes('[--json]')) commands.add(match[1]);
  }
  return [...commands].sort();
}

/** Every command that heads a row in for-ai-agents.md's Part 2 `--json` capability map (the verb cell `` `<verb> --json` ``). */
function jsonMapCommands(docsSite: string): string[] {
  const markdown = fs.readFileSync(path.join(docsSite, 'for-ai-agents.md'), 'utf8');
  const start = markdown.indexOf('## Part 2');
  assert.ok(start !== -1, 'for-ai-agents.md is missing its "## Part 2" heading');
  const afterStart = markdown.slice(start);
  // Part 2 is the final section, but stop at any later `## ` heading defensively.
  const nextSection = afterStart.indexOf('\n## ', '## Part 2'.length);
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  const commands = new Set<string>();
  const rowCommand = /^\|\s*`([a-z][a-z0-9-]*) --json`\s*\|/gm;
  for (let match = rowCommand.exec(section); match !== null; match = rowCommand.exec(section)) {
    commands.add(match[1]);
  }
  return [...commands].sort();
}

/** Returns leaf paths for nested JSON objects while retaining top-level arrays as one field. */
function fieldPathsFromValue(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value) || typeof value !== 'object' || value === null) return prefix === '' ? [] : [prefix];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix === '' ? [] : [prefix];
  return entries.flatMap(([key, child]) => fieldPathsFromValue(child, prefix === '' ? key : `${prefix}.${key}`));
}

function fieldPathsFromJson(rendered: string): string[] {
  return fieldPathsFromValue(JSON.parse(rendered));
}

function fieldPathsFromEnvelope(envelope: object): string[] {
  return fieldPathsFromValue(envelope);
}

/** Derive fields carried by representative objects inside additive arrays without inventing index-bearing paths. */
function arrayItemFieldPathsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === 'object' && item !== null && !Array.isArray(item) ? fieldPathsFromValue(item) : [],
    );
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap((child) => arrayItemFieldPathsFromValue(child));
}

function allEmittedFieldPaths(value: object | string): string[] {
  const direct = typeof value === 'string' ? fieldPathsFromJson(value) : fieldPathsFromEnvelope(value);
  const parsed: object = typeof value === 'string' ? JSON.parse(value) as object : value;
  return [...new Set([...direct, ...arrayItemFieldPathsFromValue(parsed)])];
}

function topLevelFieldNamesFromJson(rendered: string): string[] {
  return Object.keys(JSON.parse(rendered) as Record<string, unknown>);
}

function topLevelFieldNamesFromEnvelope(envelope: object): string[] {
  return Object.keys(envelope);
}

/** Derive only paths added by an enriched sample; unchanged nested shapes remain covered by the existing top-level contract. */
function newlyEmittedFieldPaths(base: object | string, enriched: object | string): string[] {
  const basePaths = new Set(allEmittedFieldPaths(base));
  const enrichedPaths = allEmittedFieldPaths(enriched);
  return enrichedPaths.filter((field) => !basePaths.has(field));
}

function unionFieldNames(...sets: readonly string[][]): string[] {
  return [...new Set(sets.flat())];
}

/**
 * Executes the public JSON-envelope builders with complete harmless sample
 * inputs. This keeps the field inventory attached to the serializers rather
 * than a second hand-maintained list in the docs test.
 */
/** A harmless, no-differences `SidecarDiff` — the shared shape `regenerate` and `diff` both publish. */
const emptySidecarDiff: SidecarDiff = {
  fields: [],
  steps: { added: [], removed: [], changed: [] },
  assertions: { added: [], removed: [], changed: [] },
  summary: { assertions: 0, steps: 0, planFacts: 0, caveats: 0, bookkeeping: 0, regenerated: false, empty: true },
};

function emittedJsonFields(): ReadonlyMap<string, readonly string[]> {
  const sessionDiscovery = {
    provenance: 'exact',
    meta: null,
    ranked: [],
    entries: [],
    completionCounts: {},
    completionCoverage: {},
    refresh: {},
    appScope: { scope: { app: 'example', prefixes: ['https://example.test'] }, excludedSessions: 0 },
  };
  // Exercise every conditional coarse-scan top-level field. `meta: null`
  // cannot inventory these serializers' additive branch, so this mirrors the
  // real live coarse payload shape as well as the exact baseline above.
  const coarseDiscovery = {
    ...sessionDiscovery,
    provenance: 'coarse',
    meta: {
      scanUntil: '2026-01-01T00:00:00.000Z',
      sessionsSeen: 1200,
      totalSessionsAtScanStart: 1200,
      capped: false,
      windowHours: 720,
      rowsSkipped: 0,
      backfillEstimate: { sessions: 1200, pendingSlices: 2, historyDays: 2, estimatedPages: 6, estimatedMinutes: 1 },
      projectWideScan: { source: 'live', sharedCache: true },
    },
  };
  let sessions = formatSessionsJson(sessionDiscovery as never, true, 0);
  sessions = appendSessionsCoverage(sessions, {
    planIndex: [],
    specSlugs: new Set(),
    suiteFiles: [],
    suiteScan: { state: 'available' },
  } as never);
  sessions = appendSessionsGapsOnly(sessions);
  sessions = appendSessionsReplayContract(sessions, {
    config: undefined,
    checkAvailability: false,
    fetchAvailability: () => null,
  });
  sessions = appendSessionsShapeFilter(sessions, { requested: [], perShape: [] } as never);
  sessions = appendSessionsSemanticsDisclosure(sessions, true, { overridesActive: true, paramNames: ['step'] } as never);
  sessions = appendSessionsPlanReviewDisclosure(sessions, true, { plans: [{ replanCommand: 'replaytest plan user' }] } as never);
  sessions = appendSessionsSupersededPlansDisclosure(sessions, true, {
    plans: [{ slug: 'example', supersededBy: 'replacement', generatedAt: '2026-01-01T00:00:00.000Z', reconcileCommand: 'replaytest reconcile' }],
  } as never);

  let limitedSessions = formatSessionsJson(sessionDiscovery as never, true, 0);
  limitedSessions = appendSessionsCoverage(limitedSessions, {
    planIndex: [],
    specSlugs: new Set(),
    suiteFiles: [],
    suiteScan: { state: 'limited', cappedBy: 'maxDirectories', skippedStandardDirs: true },
  } as never);
  limitedSessions = appendSessionsGapsOnly(limitedSessions);
  limitedSessions = appendSessionsReplayContract(limitedSessions, {
    config: undefined,
    checkAvailability: false,
    fetchAvailability: () => null,
  });
  limitedSessions = appendSessionsShapeFilter(limitedSessions, { requested: [], perShape: [] } as never);
  limitedSessions = appendSessionsSemanticsDisclosure(limitedSessions, true, { overridesActive: true, paramNames: ['step'] } as never);
  limitedSessions = appendSessionsPlanReviewDisclosure(limitedSessions, true, { plans: [{ replanCommand: 'replaytest plan user' }] } as never);
  limitedSessions = appendSessionsSupersededPlansDisclosure(limitedSessions, true, {
    plans: [{ slug: 'example', supersededBy: 'replacement', generatedAt: '2026-01-01T00:00:00.000Z', reconcileCommand: 'replaytest reconcile' }],
  } as never);

  const sessionFields = new Set(topLevelFieldNamesFromJson(sessions));
  for (const field of topLevelFieldNamesFromJson(limitedSessions)) sessionFields.add(field);
  for (const field of topLevelFieldNamesFromJson(formatFamiliesJson(sessionDiscovery as never, [], [], true, 0))) sessionFields.add(field);
  for (const field of topLevelFieldNamesFromJson(formatSessionsJson(coarseDiscovery as never, true, 0))) sessionFields.add(field);
  for (const field of topLevelFieldNamesFromJson(formatFamiliesJson(coarseDiscovery as never, [], [], true, 0))) sessionFields.add(field);
  for (const field of topLevelFieldNamesFromJson(formatStoredSessionsJson(JSON.parse(sessions) as Record<string, unknown>, {}, {}))) {
    sessionFields.add(field);
  }
  for (const field of newlyEmittedFieldPaths(sessions, limitedSessions)) sessionFields.add(field);

  // The gap map here is synthetic. `sections` is a required field of `GapMap`
  // (src/gap-map.ts) and `countGapMapRows` reduces over it, so the fixture
  // supplies the type-valid empty array instead of relying on a production
  // fallback (a silent `?? []` there would weaken the docs probe).
  const gaps = formatGapsJson(
    sessionDiscovery as never,
    { sections: [] } as never,
    {} as never,
    {} as never,
  );
  const coarseGaps = formatGapsJson(
    coarseDiscovery as never,
    { sections: [] } as never,
    {} as never,
    {} as never,
  );
  const limitedGaps = formatGapsJson(
    sessionDiscovery as never,
    { sections: [], suiteInventory: { state: 'limited', cappedBy: 'maxDirectories', skippedStandardDirs: true } } as never,
    {} as never,
  );
  const regenerateSearch: RegenerateSearch = {
    sinceHours: 720,
    signature: '/orders/:id/pay > /orders/:id/confirmation',
    signatureSource: 'sidecar',
    tierA: { candidates: 1, attempted: 1 },
    tierB: { variants: 0, candidates: 0, attempted: 0, entryChanged: false },
    appScope: { scope: { app: 'example', prefixes: ['https://example.test'] }, excludedSessions: 0 },
  };
  const regenerateResult: RegenerateResult = {
    kind: 'regenerated',
    slug: 'example',
    tier: 'same-signature',
    candidate: {
      tier: 'same-signature',
      distinctId: 'example-user',
      sessionId: 'example-session',
      lastTs: '2026-01-01T00:00:00.000Z',
      signature: regenerateSearch.signature,
      origin: 'https://example.test',
    },
    search: regenerateSearch,
    sidecar: {
      version: 1,
      title: 'Example journey',
      source: {
        distinctId: 'example-user',
        sessionId: 'example-session',
        journeyIndex: 0,
        signature: regenerateSearch.signature,
        generatedAt: '2026-01-01T00:00:00.000Z',
        tool: 'replaytest@0.1.0',
      },
      start: '/orders/1001/pay',
      steps: [],
      assertions: [],
    },
    markdown: '',
    diff: emptySidecarDiff,
  };
  const regenerateRefusal: RegenerateRefusal = {
    kind: 'refusal',
    code: 'no-candidates',
    message: 'missing',
    exitCode: 1,
    search: regenerateSearch,
  };

  const preflightInput = {
    baseUrl: 'http://localhost:8000',
    baseUrlSource: 'default',
    baseUrlFallbackReason: 'unset',
    targetAppUrl: 'http://localhost:8000',
    summary: {},
    steps: [],
    authRedirect: { recordedAction: 1, requestedPath: '/dashboard', landedPath: '/login', matchesWitnessedLoginPath: true, passwordInputPresent: false },
  };
  const preflightBase = preflightJsonEnvelope(
    preflightInput as never,
    'example',
    { verdict: 'unknown', keying: 'content-hash/v1', planIsReadable: true },
    true,
  );
  const preflightDeclared = preflightJsonEnvelope(
    preflightInput as never,
    'example',
    { verdict: 'unknown', keying: 'content-hash/v1', handFinishedDeclared: true, planIsReadable: true },
    true,
  );
  const preflightStale = preflightJsonEnvelope(
    preflightInput as never,
    'example',
    { verdict: 'unknown', keying: 'content-hash/v1', handFinishedStale: true, planIsReadable: true },
    false,
  );
  const preflightFields = new Set(topLevelFieldNamesFromEnvelope(preflightBase));
  for (const field of newlyEmittedFieldPaths(preflightBase, preflightDeclared)) preflightFields.add(field);
  for (const field of newlyEmittedFieldPaths(preflightBase, preflightStale)) preflightFields.add(field);
  const preflightDrifts = [preflightDeclared, preflightStale].map((envelope) => (envelope as { drift: Record<string, unknown> }).drift);
  assert.ok(
    preflightDrifts.every((drift) => !(Object.hasOwn(drift, 'handFinishedDeclared') && Object.hasOwn(drift, 'handFinishedStale'))),
    'preflight nested drift fixtures must represent declared-only and stale-only states, not an impossible combined state',
  );

  const healEnvelope = (relocated: boolean): object => healJsonEnvelope({
    generatedAt: '2026-01-01T00:00:00.000Z',
    resultsDisplayPath: 'results.json',
    runStartedAt: '2026-01-01T00:00:00.000Z',
    runAgeLabel: 'fresh',
    window: {},
    coarseScanFetchCount: 0,
    observedSpecs: [],
    runScope: {},
    suiteFingerprint: {},
    slugs: [{
      slug: 'example',
      file: 'tests/generated/moved.spec.ts',
      mappingSource: 'header',
      drift: {
        verdict: 'unknown',
        keying: 'content-hash/v1',
        handEditStatus: 'stamped-clean',
        planIsReadable: true,
        ...(relocated ? { relocatedSpec: { specPath: 'tests/generated/moved.spec.ts', driftAssessed: false } } : {}),
      },
      hasSpec: false,
      result: { kind: 'refusal', refusal: { code: 'signature-unresolvable', message: 'example' } },
    }],
    flaky: [],
    notTrafficExplicable: [],
    outOfScope: [],
    unmappable: [],
    globalErrors: [],
  } as never);
  const healBase = healEnvelope(false);
  const healRelocated = healEnvelope(true);
  const healFields = new Set(topLevelFieldNamesFromEnvelope(healBase));
  for (const field of newlyEmittedFieldPaths(healBase, healRelocated)) healFields.add(field);

  const suiteStatusEnvelope = (relocated: boolean, partial = false, includeScan = true): object => suiteStatusJsonEnvelope({
    window: {},
    coarseScanFetchCount: 0,
    entries: [{
      slug: 'example',
      verdict: 'dead',
      hasSpec: false,
      drift: {
        verdict: 'unknown',
        keying: 'content-hash/v1',
        planIsReadable: true,
        ...(relocated ? { relocatedSpec: { specPath: 'tests/generated/moved.spec.ts', driftAssessed: false } } : {}),
      },
      note: 'example',
    }],
    supersededPlans: [],
    ...(includeScan ? {
      generatedSpecScan: {
        capped: partial,
        ...(partial ? { cappedBy: 'maxFiles' } : {}),
        skippedStandardDirs: false,
        unreadableFiles: 0,
        duplicateSlugs: [],
      },
    } : {}),
  } as never);
  const suiteStatusWithoutScan = suiteStatusEnvelope(false, false, false);
  const suiteStatusBase = suiteStatusEnvelope(false);
  const suiteStatusRelocated = suiteStatusEnvelope(true);
  const suiteStatusPartial = suiteStatusEnvelope(false, true);
  const suiteStatusFields = new Set(topLevelFieldNamesFromJson(formatSuiteStatusOutput(JSON.stringify(suiteStatusBase), {})));
  for (const field of newlyEmittedFieldPaths(suiteStatusBase, suiteStatusRelocated)) suiteStatusFields.add(field);
  for (const field of newlyEmittedFieldPaths(suiteStatusWithoutScan, suiteStatusBase)) suiteStatusFields.add(field);
  for (const field of newlyEmittedFieldPaths(suiteStatusBase, suiteStatusPartial)) suiteStatusFields.add(field);

  return new Map([
    ['sessions', [...sessionFields]],
    ['gaps', unionFieldNames(
      topLevelFieldNamesFromJson(gaps),
      topLevelFieldNamesFromJson(coarseGaps),
      topLevelFieldNamesFromJson(limitedGaps),
      newlyEmittedFieldPaths(gaps, limitedGaps),
    )],
    ['scan-status', topLevelFieldNamesFromJson(formatScanStatusJson({
      state: 'settled-with-holes',
      source: 'coarse-store-manifest',
      contactedPostHog: false,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      window: { sinceHours: 720, from: '2025-12-02T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z', dayDefinition: 'UTC 24-hour history block' },
      settledThrough: '2025-12-20T00:00:00.000Z',
      settledRanges: { items: [], total: 0, shown: 0, truncated: false },
      awaitingAgreement: { items: [], total: 0, shown: 0, truncated: false },
      gaps: { items: [], total: 0, shown: 0, truncated: false, reasons: [] },
      message: 'example',
    }))],
    ['doctor', unionFieldNames(
      topLevelFieldNamesFromEnvelope(doctorJsonEnvelope({ probes: [], summary: '', window: {} } as never)),
      topLevelFieldNamesFromJson(formatDoctorRefusalJson({ code: 'unconfigured', message: 'configure' } as never)),
    )],
    ['explain', unionFieldNames(...explainJsonFixtureEnvelopes().map((envelope) => topLevelFieldNamesFromEnvelope(envelope)))],
    ['preflight', unionFieldNames(
      // The preflight envelope, not the bare liveness one: preflight also
      // publishes the shared plan/spec drift state, and that field has to be
      // visible to this gate or it could ship undocumented.
      [...preflightFields],
      topLevelFieldNamesFromJson(formatPreflightRefusalJson('missing-sidecar', 'missing')),
    )],
    ['triage', unionFieldNames(
      topLevelFieldNamesFromEnvelope(triageJsonEnvelope({
        verdict: 'healthy',
        signature: {},
        signatureSource: 'sidecar',
        window: {},
        artifacts: {},
        evidence: {},
        secondaryFindings: [],
        flowShiftWatch: {},
        proposed: {},
        evidenceSource: {},
      } as never)),
      topLevelFieldNamesFromJson(formatTriageRefusalJson({ code: 'missing-sidecar', message: 'missing' } as never)),
    )],
    ['regenerate', unionFieldNames(
      topLevelFieldNamesFromJson(formatRegenerateJson(regenerateResult)),
      topLevelFieldNamesFromJson(formatRegenerateRefusalJson(regenerateRefusal)),
    )],
    ['diff', unionFieldNames(
      topLevelFieldNamesFromJson(formatDiffJson('example', emptySidecarDiff)),
      // The conditional note (a disclosed freshness-evidence gap) only
      // rides on a diff that moved a locator, so the empty-diff call above
      // cannot inventory it — this second call is what keeps it inside the
      // currency gate instead of shipping undocumented.
      topLevelFieldNamesFromJson(formatDiffJson('example', emptySidecarDiff, 'note')),
      topLevelFieldNamesFromJson(formatDiffRefusalJson({ kind: 'refusal', code: 'missing-sidecar', message: 'missing', exitCode: 1 })),
    )],
    ['heal', [...healFields]],
    ['accept', unionFieldNames(
      topLevelFieldNamesFromJson(formatAcceptJson({} as never)),
      topLevelFieldNamesFromJson(formatAcceptRefusalJson({ code: 'missing-live-plan', message: 'missing' } as never)),
    )],
    ['retire', unionFieldNames(
      topLevelFieldNamesFromJson(formatRetireResultJson({} as never)),
      topLevelFieldNamesFromJson(formatRetireRefusalJson({ code: 'no-plan', message: 'missing' } as never)),
      topLevelFieldNamesFromJson(formatRetireEvidenceViewJson({} as never)),
    )],
    ['fix-selector', unionFieldNames(
      topLevelFieldNamesFromJson(formatFixSelectorJson({} as never)),
      topLevelFieldNamesFromJson(formatFixSelectorJson({} as never, { kind: 'synchronized' }, 'example')),
    )],
    ['suite-status', [...suiteStatusFields]],
    ['suite-health', topLevelFieldNamesFromJson(formatSuiteHealthJson({ health: {} as never, coverageRecompute: {} as never }))],
  ]);
}

function documentedJsonFields(markdown: string, command: string): string[] {
  const row = markdown.split(/\r?\n/).find((line) => line.startsWith(`| \`${command} --json\` |`));
  assert.ok(row !== undefined, `for-ai-agents.md is missing the ${command} --json row`);
  const schema = /`\{([^}]*)\}`/.exec(row)?.[1];
  assert.ok(schema !== undefined, `for-ai-agents.md ${command} --json row is missing its leading object-field schema`);
  const topLevel = [...schema.matchAll(/(?:^|,)\s*([a-z][a-zA-Z0-9]*)\??(?=\s*(?::|,|$))/g)].map((match) => match[1]!);
  const dotted = [...row.matchAll(/\b([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\??/g)].map((match) => match[1]!);
  return [...new Set([...topLevel, ...dotted])];
}

const EXPLAIN_JSON_VERSIONED_KINDS = ['resolved', 'list', 'unknown-code', 'ambiguous-code'] as const;

const EXPLAIN_JSON_CLI_CONTRACT_SENTENCE = 'When the arguments are invalid, `explain --json` returns the plain usage-error object `{ error: { code, message } }`, with no `schemaVersion` or `kind` (the same format other commands use for usage errors); the resolved, list, unknown-code, and ambiguous-code forms remain versioned at `schemaVersion: 1`. Each resolved `cases[]` entry carries `{ description, message, exitCode }`, where `exitCode` is the integer exit code for that situation. In a resolved entry, `tier` says in plain words whether the code is shown in command output, and `override` is either an object or `null`. A field that is absent is not the same as `null`.';
const EXPLAIN_JSON_FOR_AI_CONTRACT_SENTENCE = 'The top-level keys of `explain --json`, across all its forms, are: `{ error?, schemaVersion?, kind?, code?, nsCode?, verb?, contentStatus?, message?, meaning?, evidenceClass?, jsonVisible?, exitCode?, tier?, cases?, override?, nextSteps?, coverage?, entries?, suggestions?, candidates? }`. Argument-validation failures use the unversioned shared `{ error: { code, message } }` usage-error envelope, with no `schemaVersion` or `kind`. The four versioned forms are resolved, list, unknown-code, and ambiguous-code. Each resolved `cases[]` entry carries `{ description, message, exitCode }`, where `exitCode` is the integer outcome for that situation.';

/** Keeps the four versioned explain kinds and shared unversioned usage envelope attached to real serializers. */
function assertExplainEnvelopeKindDocs(cliReference: string, forAi: string): void {
  const envelopes = explainJsonFixtureEnvelopes();
  assert.equal(envelopes.length, 5, 'explainJsonFixtureEnvelopes must carry four versioned forms and one shared usage-error form');
  const versioned = envelopes.filter((envelope) => typeof (envelope as { kind?: unknown }).kind === 'string');
  const unversioned = envelopes.filter((envelope) => !Object.hasOwn(envelope, 'kind'));
  const kinds = [...new Set(versioned.map((envelope) => (envelope as { kind: string }).kind))];
  assert.deepEqual(
    kinds,
    EXPLAIN_JSON_VERSIONED_KINDS,
    'explainJsonFixtureEnvelopes must carry every current documented versioned envelope kind',
  );
  assert.equal(unversioned.length, 1, 'explainJsonFixtureEnvelopes must carry exactly one unversioned usage-error envelope');
  const usageError = unversioned[0] as { error?: unknown };
  assert.equal(Object.hasOwn(usageError, 'kind'), false, 'the shared usage-error envelope must not acquire a versioned kind');
  assert.deepEqual(Object.keys(usageError), ['error'], 'the shared usage-error envelope must have exactly one top-level error key');
  assert.deepEqual(Object.keys(usageError.error as object), ['code', 'message'], 'the shared usage-error payload must have exactly code and message');
  assert.equal((usageError.error as { code: unknown }).code, 'usage-error');
  assert.equal(typeof (usageError.error as { message: unknown }).message, 'string');
  const lastKind = EXPLAIN_JSON_VERSIONED_KINDS[EXPLAIN_JSON_VERSIONED_KINDS.length - 1];
  const kindList = `${EXPLAIN_JSON_VERSIONED_KINDS.slice(0, -1).join(', ')}, and ${lastKind}`;
  assert.ok(
    cliReference.includes(`the ${kindList} forms remain versioned at \`schemaVersion: 1\``),
    'cli-reference.md must document the four versioned explain kinds and shared unversioned usage-error shape',
  );
  assert.ok(
    forAi.includes(`The four versioned forms are ${kindList}`),
    'for-ai-agents.md must document the four versioned explain kinds and shared unversioned usage-error shape',
  );
  assert.ok(
    cliReference.includes(EXPLAIN_JSON_CLI_CONTRACT_SENTENCE),
    'cli-reference.md must document the four versioned explain kinds and shared unversioned usage-error shape',
  );
  assert.ok(
    forAi.includes(EXPLAIN_JSON_FOR_AI_CONTRACT_SENTENCE),
    'for-ai-agents.md must document the four versioned explain kinds and shared unversioned usage-error shape',
  );
  assert.doesNotMatch(forAi, /<!--\s*Residual source inventory:/, 'for-ai-agents.md must not ship the internal residual source inventory comment');
}

const EXPLAIN_MESSAGE_TEMPLATE_CLI_REFERENCE = 'The `message` field is the exact refusal message template; `{{…}}` marks parts filled in when the command runs — with a value, a context-dependent phrase, or nothing at all.';
const EXPLAIN_MESSAGE_TEMPLATE_FOR_AI = 'For a resolved entry, `message` is the exact refusal message template; `{{…}}` marks parts filled in when the command runs — with a value, a context-dependent phrase, or nothing at all.';

/** Keeps the documented interpolation convention attached to the serialized message field. */
function assertExplainMessageTemplateDocs(cliReference: string, forAi: string): void {
  assert.ok(
    cliReference.includes(EXPLAIN_MESSAGE_TEMPLATE_CLI_REFERENCE),
    'cli-reference.md must explain that resolved message values are exact templates with runtime interpolation markers',
  );
  assert.ok(
    forAi.includes(EXPLAIN_MESSAGE_TEMPLATE_FOR_AI),
    'for-ai-agents.md explain --json row must explain that message values are exact templates with runtime interpolation markers',
  );
}

function commandFixture(command: string): string {
  if (command === 'help') return fs.readFileSync(path.join(CLI_FIXTURES_DIRECTORY, 'cli-help.txt'), 'utf8');
  const fixture = SAFE_CLI_FIXTURES.find((candidate) => candidate.args[0] === command && candidate.args[1] === '--help');
  assert.ok(fixture !== undefined, `SAFE_CLI_FIXTURES is missing ${command} --help; every CLI verb needs a safe per-verb fixture`);
  return fs.readFileSync(path.join(CLI_FIXTURES_DIRECTORY, `${fixture.name}.txt`), 'utf8');
}

function cliFlagsForCommand(command: string): string[] {
  const usage = commandFixture(command).split(/\r?\n/).find((line) => line.startsWith(`  replaytest ${command}`));
  assert.ok(usage !== undefined, `could not find the ${command} usage line in its help fixture`);
  return [...new Set(usage.match(/(?<![\w-])(?:--[a-z][a-z0-9-]*|-[a-z])(?![\w-])/g) ?? [])].sort();
}

// The README Commands section names the verbs (with their main argument) and defers the
// complete flag list to the CLI reference. Three featured rows are pinned here by their exact command cell;
// the full per-command, per-flag guard lives on cli-reference.md (see assertFeatureDocsCurrency).
const FEATURED_README_COMMANDS = ['sessions', 'plan', 'scaffold'] as const;
const FEATURED_README_COMMAND_CELLS: Readonly<Record<(typeof FEATURED_README_COMMANDS)[number], string>> = {
  sessions: 'sessions',
  plan: 'plan <distinctId>',
  scaffold: 'scaffold <slug>',
};

function commandReferenceRows(readme: string): ReadonlyMap<string, string> {
  const heading = '## 🧰 Commands';
  const start = readme.indexOf(heading);
  assert.ok(start !== -1, `README.md is missing its "${heading}" heading`);
  const afterStart = readme.slice(start);
  const nextSection = afterStart.indexOf('\n## ', heading.length);
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  const rows = new Map<string, string>();
  for (const command of FEATURED_README_COMMANDS) {
    // Anchor to the exact command cell: `| `plan <distinctId>` |`. Matching the backticked
    // command anywhere on a line would let a deleted row pass when another row's description
    // names the command in backticks (`triage --propose` → `diff` → `accept` names three).
    const cell = FEATURED_README_COMMAND_CELLS[command];
    const row = section.split(/\r?\n/).find((line) => line.startsWith(`| \`${cell}\` |`));
    assert.ok(row !== undefined, `README.md Commands table is missing the ${command} row`);
    rows.set(command, row);
  }
  return rows;
}

function cliReferenceSection(markdown: string, command: string): string {
  const heading = `## \`${command}\``;
  const start = markdown.indexOf(heading);
  assert.ok(start !== -1, `cli-reference.md is missing the ${heading} section`);
  const afterStart = markdown.slice(start);
  const nextSection = afterStart.indexOf('\n## ', heading.length);
  return nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
}

/** The three bounded customer-documentation surfaces covered by the feature-currency rule. */
export function assertFeatureDocsCurrency(root: string): void {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const cliReference = fs.readFileSync(path.join(root, 'docs', 'site', 'cli-reference.md'), 'utf8');
  const forAi = fs.readFileSync(path.join(root, 'docs', 'site', 'for-ai-agents.md'), 'utf8');
  const readmeRows = commandReferenceRows(readme);
  assertExplainEnvelopeKindDocs(cliReference, forAi);
  assertExplainMessageTemplateDocs(cliReference, forAi);
  const pointer = 'Every command and flag: [CLI reference](docs/site/cli-reference.md).';
  assert.ok(readme.includes(pointer), 'README.md Command reference needs its complete-flags pointer to docs/site/cli-reference.md');

  // The README Commands tables name the verbs and defer the complete flag list to the
  // CLI reference through the pointer above; the per-flag guard below runs on cli-reference.md.
  for (const command of FEATURED_README_COMMANDS) {
    assert.ok(readmeRows.has(command), `README.md Commands table is missing the ${command} row`);
  }

  for (const command of cliCommandsFromHelpFixture()) {
    for (const flag of cliFlagsForCommand(command)) {
      assert.ok(
        cliReferenceSection(cliReference, command).includes(flag),
        `cli-reference.md ${command} section is missing ${flag} from the live ${command} --help synopsis.`,
      );
    }
  }

  const emittedCommands = [...emittedJsonFields().keys()].sort();
  const jsonCommands = jsonCapableCommandsFromHelpFixture();
  assert.deepEqual(
    emittedCommands,
    jsonCommands,
    `emittedJsonFields must cover exactly the commands whose --help advertises [--json]. Missing serializers: ${jsonCommands.filter((command) => !emittedCommands.includes(command)).join(', ')}.`,
  );

  for (const [command, emitted] of emittedJsonFields()) {
    const documented = new Set(documentedJsonFields(forAi, command));
    const missing = emitted.filter((field) => !documented.has(field));
    assert.deepEqual(
      missing,
      [],
      `for-ai-agents.md ${command} --json schema is missing emitted top-level field(s): ${missing.join(', ')}. Document additive fields before shipping the command change.`,
    );
  }
}

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spells a whole 0–99 count the way the Part 2 prose does, so the count sentences can be checked against the derived tallies. Throws (with a fix hint) above 99 so the guard fails loudly rather than silently skipping. */
function numberToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw new Error(`numberToWords supports whole numbers 0–99; got ${value}. Extend ONES/TENS to cover a larger command count.`);
  }
  if (value < 20) return ONES[value];
  const tensWord = TENS[Math.floor(value / 10)];
  const onesDigit = value % 10;
  return onesDigit === 0 ? tensWord : `${tensWord}-${ONES[onesDigit]}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Every command that has a row in for-ai-agents.md's `### Command routing table` (Part 1 only, not the Part 2 `--json` map). */
function routingTableCommands(docsSite: string): string[] {
  const markdown = fs.readFileSync(path.join(docsSite, 'for-ai-agents.md'), 'utf8');
  const start = markdown.indexOf('### Command routing table');
  assert.ok(start !== -1, 'for-ai-agents.md is missing its "### Command routing table" heading');
  const afterStart = markdown.slice(start);
  const nextSection = afterStart.indexOf('\n## ');
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  const commands = new Set<string>();
  const rowCommand = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm;
  for (let match = rowCommand.exec(section); match !== null; match = rowCommand.exec(section)) {
    commands.add(match[1]);
  }
  return [...commands].sort();
}

/** Every command that has a row in AGENT-MAINTENANCE-GUIDE.md's mirrored `## Command routing table`. */
function guideRoutingTableCommands(root: string): string[] {
  const markdown = fs.readFileSync(path.join(root, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');
  const start = markdown.indexOf('## Command routing table');
  assert.ok(start !== -1, 'AGENT-MAINTENANCE-GUIDE.md is missing its "## Command routing table" heading');
  const afterStart = markdown.slice(start);
  const nextSection = afterStart.indexOf('\n## ');
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  const commands = new Set<string>();
  const rowCommand = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm;
  for (let match = rowCommand.exec(section); match !== null; match = rowCommand.exec(section)) {
    commands.add(match[1]);
  }
  return [...commands].sort();
}

/** The full command rows in for-ai-agents.md's Part 1 routing table, in document order. */
function routingTableRows(docsSite: string): string[] {
  const markdown = fs.readFileSync(path.join(docsSite, 'for-ai-agents.md'), 'utf8');
  const start = markdown.indexOf('### Command routing table');
  assert.ok(start !== -1, 'for-ai-agents.md is missing its "### Command routing table" heading');
  const afterStart = markdown.slice(start);
  const nextSection = afterStart.indexOf('\n## ');
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  return [...section.matchAll(/^\|\s*`[a-z][a-z0-9-]*`\s*\|.*$/gm)].map((match) => match[0]);
}

/** The full command rows in AGENT-MAINTENANCE-GUIDE.md's mirrored routing table, in document order. */
function guideRoutingTableRows(root: string): string[] {
  const markdown = fs.readFileSync(path.join(root, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');
  const start = markdown.indexOf('## Command routing table');
  assert.ok(start !== -1, 'AGENT-MAINTENANCE-GUIDE.md is missing its "## Command routing table" heading');
  const afterStart = markdown.slice(start);
  const nextSection = afterStart.indexOf('\n## ');
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  return [...section.matchAll(/^\|\s*`[a-z][a-z0-9-]*`\s*\|.*$/gm)].map((match) => match[0]);
}

/** The five verdict-routing rows are a separate customer contract from the command table. */
function triageVerdictRoutingRows(markdownPath: string): string[] {
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  const marker = '**Where each verdict routes you:**';
  const start = markdown.indexOf(marker);
  assert.ok(start !== -1, `${path.basename(markdownPath)} is missing its triage verdict routing table`);
  const afterStart = markdown.slice(start + marker.length).replace(/^\n+/, '');
  const tableEnd = afterStart.indexOf('\n\n');
  const table = tableEnd === -1 ? afterStart : afterStart.slice(0, tableEnd);
  return [...table.matchAll(/^\|\s*`(?:selector-aged|flow-changed|regression-evidence|healthy|insufficient-evidence)`\s*\|.*$/gm)].map((match) => match[0]);
}

test('for-ai-agents.md routing table has a row for every CLI command', (t) => {
  if (!fs.existsSync(path.join(docsSiteDirectory, 'for-ai-agents.md'))) {
    t.skip('for-ai-agents.md does not exist yet; the routing-table parity check activates when the docs land.');
    return;
  }

  const cliCommands = cliCommandsFromHelpFixture();
  assert.ok(cliCommands.length > 0, 'parsed no commands from cli-help.txt — the usage-line parser has drifted');

  const tableCommands = routingTableCommands(docsSiteDirectory);

  const missing = cliCommands.filter((command) => !tableCommands.includes(command));
  assert.deepEqual(
    missing,
    [],
    `for-ai-agents.md routing table is missing a row for: ${missing.join(', ')}. Every command in the CLI's --help must appear as a routing-table row.`,
  );

  const phantom = tableCommands.filter((command) => !cliCommands.includes(command));
  assert.deepEqual(
    phantom,
    [],
    `for-ai-agents.md routing table has a row for a command the CLI does not expose: ${phantom.join(', ')}. Remove the stale row or restore the verb.`,
  );
});

test('AGENT-MAINTENANCE-GUIDE.md routing table has every canonical Part 1 command', () => {
  const canonicalCommands = routingTableCommands(docsSiteDirectory);
  const guideCommands = guideRoutingTableCommands(repoRoot);

  const missing = canonicalCommands.filter((command) => !guideCommands.includes(command));
  assert.deepEqual(
    missing,
    [],
    `AGENT-MAINTENANCE-GUIDE.md routing table is missing a canonical Part 1 row for: ${missing.join(', ')}. Mirror every command in for-ai-agents.md's Part 1 routing table.`,
  );

  const phantom = guideCommands.filter((command) => !canonicalCommands.includes(command));
  assert.deepEqual(
    phantom,
    [],
    `AGENT-MAINTENANCE-GUIDE.md routing table has a phantom row not in canonical Part 1: ${phantom.join(', ')}. Remove the stale row or add the command to for-ai-agents.md's Part 1 routing table.`,
  );
});

test('AGENT-MAINTENANCE-GUIDE.md routing table row text mirrors canonical Part 1', () => {
  assert.deepEqual(
    guideRoutingTableRows(repoRoot),
    routingTableRows(docsSiteDirectory),
    'AGENT-MAINTENANCE-GUIDE.md routing-table command rows must match for-ai-agents.md Part 1 exactly.',
  );
});

const REGENERATE_REPAIR_MIRROR_COPY = [
  'Candidates from another origin than the live plan, candidates that span origins, and candidates that lack a witnessed origin are refused unless you deliberately pass `--allow-cross-origin`.',
  'For an ordinary `triage --propose` or `heal --propose` proposal, `accept` compares the session ID behind the proposal with the one behind the live plan.',
  'Regenerate Tier A changes to a fresh recording but keeps the same journey identity, so its replacement is disclosed but needs no extra consent.',
  '`tests/generated/<slug>.spec.ts` has no hand edits and the slug is undeclared: run `replaytest scaffold <slug> --force`.',
  'The slug is declared hand-finished: you get a notice instead. Remove that declaration before any deliberate re-scaffold.',
  'The spec has hand edits: apply the reviewed delta yourself instead. While this accepted plan still matches, `heal`, `suite-status` and `preflight` report `accepted-unverified`, because replaytest cannot prove the hand edit. A later plan change becomes `unverified`; an untouched machine spec can be confidently `drifted`.',
  'If the hand-finished registry is broken, commands stop instead of guessing.',
  'A declared slug that has neither a plan nor a spec blocks nothing, and no command reports it: commands that work through your plans simply skip it.',
] as const;

const PLAN_PROPERTY_BOUNDARY_MIRROR_COPY = [
  'That refusal is named `cross-origin-journeys`, the first-generation sibling of `regenerate`\'s `cross-origin-candidates`',
  '`plan` has no `--json` surface, so today the code appears only internally, not in printed output.',
  'The refusal withholds the WHOLE run, because `plan` writes a session\'s journeys as one batch: any other plannable journey in that session is held back with it, and `--allow-cross-origin` releases the whole run.',
] as const;

test('agent-maintenance guides name plan\'s property-boundary refusal code and its whole-run consequence', () => {
  const canonical = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');
  for (const copy of PLAN_PROPERTY_BOUNDARY_MIRROR_COPY) {
    assert.ok(canonical.includes(copy), `for-ai-agents.md is missing required plan property-boundary guidance: ${copy}`);
    assert.ok(guide.includes(copy), `AGENT-MAINTENANCE-GUIDE.md is missing required plan property-boundary guidance: ${copy}`);
  }
});

const REGENERATE_ORIGIN_RECOVERY_MIRROR_COPY = [
  'no site address could be resolved from the plan, its retained source session or the selected app scope. Select an app scope configured with one origin, re-plan from a retained source session, or use `--allow-cross-origin` only after confirming which site to consider.',
  'fresh traffic crossed the property boundary or lacks a witnessed origin. Select the intended app scope, or pass `--allow-cross-origin` only after reviewing the other property.',
] as const;

function normalizeMarkdownWhitespace(markdown: string): string {
  return markdown.replace(/\s+/g, ' ').trim();
}

test('agent-maintenance guides and the packed repair skill pin regenerate origin recovery and the two consent/drift branches', () => {
  const canonical = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');
  for (const copy of REGENERATE_REPAIR_MIRROR_COPY) {
    assert.ok(canonical.includes(copy), `for-ai-agents.md is missing required regenerate repair guidance: ${copy}`);
    assert.ok(guide.includes(copy), `AGENT-MAINTENANCE-GUIDE.md is missing required regenerate repair guidance: ${copy}`);
  }
  const skill = fs.readFileSync(path.join(repoRoot, 'skills', 'replaytest-repair', 'SKILL.md'), 'utf8');
  const normalizedCopies = [canonical, guide, skill].map(normalizeMarkdownWhitespace);
  for (const copy of REGENERATE_ORIGIN_RECOVERY_MIRROR_COPY) {
    assert.ok(normalizedCopies[0]!.includes(copy), `for-ai-agents.md is missing required regenerate origin recovery: ${copy}`);
    assert.ok(normalizedCopies[1]!.includes(copy), `AGENT-MAINTENANCE-GUIDE.md is missing required regenerate origin recovery: ${copy}`);
    assert.ok(normalizedCopies[2]!.includes(copy), `skills/replaytest-repair/SKILL.md is missing required regenerate origin recovery: ${copy}`);
  }
});

test('the packed repair skill owns the hand-finished disclosure copy and its structural refusal remedy', () => {
  const skill = fs.readFileSync(path.join(repoRoot, 'skills', 'replaytest-repair', 'SKILL.md'), 'utf8');
  const normalizedSkill = normalizeMarkdownWhitespace(skill);
  assert.ok(normalizedSkill.includes('The slug is declared hand-finished: you get a notice instead. Remove that declaration before any deliberate re-scaffold.'), 'SKILL.md must retain the declared-slug disclosure copy');
  assert.ok(normalizedSkill.includes('If the hand-finished registry is broken, commands stop instead of guessing.'), 'SKILL.md must disclose the structural registry refusal');
  assert.ok(normalizedSkill.includes('until you repair `.replaytest/hand-finished.json`.'), 'SKILL.md must name the registry remedy');
});

test('AGENT-MAINTENANCE-GUIDE.md triage verdict routing rows mirror canonical Part 1', () => {
  const guideRows = triageVerdictRoutingRows(path.join(repoRoot, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'));
  const canonicalRows = triageVerdictRoutingRows(path.join(docsSiteDirectory, 'for-ai-agents.md'));
  assert.equal(guideRows.length, 5, 'AGENT-MAINTENANCE-GUIDE.md must expose exactly five triage verdict-routing rows.');
  assert.equal(canonicalRows.length, 5, 'for-ai-agents.md must expose exactly five triage verdict-routing rows.');
  assert.deepEqual(
    guideRows,
    canonicalRows,
    'AGENT-MAINTENANCE-GUIDE.md triage verdict-routing rows must match canonical for-ai-agents.md exactly.',
  );
});

/**
 * The standalone kit guide and the docs-site guide must give the same
 * state-conditioned hand-off. This intentionally pins the user-facing
 * completion copy in BOTH directions instead of merely checking that the
 * two pages mention the same commands somewhere.
 */
const FRESH_SCAFFOLD_MIRROR_COPY = [
  'At scaffold time, every generated spec is a fresh, never-green draft. Finish that draft before treating a failure as a regression.',
  '`preflight` is a fast, free local check with no PostHog calls.',
  'An exit-1 report headed `INCONCLUSIVE` means preflight checked no selectors. It is a no-check outcome, not proof of a dead locator. Restore access to the target app, or run the full spec next.',
  'An exit-1 report headed `DEAD SELECTORS` means preflight directly checked and found one or more dead recorded locators. Run `triage` to learn what changed.',
  'Steps after a recorded submit are reported gated, not DEAD; a genuinely removed element there surfaces when the full spec runs.',
  'The tool enforces this itself, and refuses in three cases:\n  - In a git workspace, `.replaytest/frames` is not covered by `.gitignore`. Add `.replaytest/` to that file.\n  - Outside a git workspace, `.gitignore` cannot apply. Pass `--allow-unignored` only when you have deliberately secured the folder some other way.\n  - Git itself is unavailable, so the tool cannot determine ignore status. `--allow-unignored` is again the deliberate override.',
  'Never infer or reconstruct a masked value from context.',
  'That observed first green run is the hand-off from completion to maintenance.',
  'If this now-established test later goes red, use `preflight` first for the local signal, then start the repair loop\'s traffic diagnosis with `triage` before hand-fixing selectors.',
  'A hand-authored `data-testid` is different: it is a stable, load-bearing test contract, so keep it rather than treating it as a disposable generated id.',
] as const;

test('AGENT-MAINTENANCE-GUIDE.md fresh-scaffold completion copy mirrors canonical Part 1', () => {
  const canonical = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');

  for (const copy of FRESH_SCAFFOLD_MIRROR_COPY) {
    assert.ok(canonical.includes(copy), `for-ai-agents.md is missing mirrored completion copy: ${copy}`);
    assert.ok(guide.includes(copy), `AGENT-MAINTENANCE-GUIDE.md is missing canonical completion copy: ${copy}`);
  }
});

/** The one bullet that defines the hand-finished registry; both agent guides carry it and it must read the same in each. */
function handFinishedRegistryDefinitionBullets(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('- The *hand-finished registry* is `.replaytest/hand-finished.json`.'));
}

test('the hand-finished registry definition reads byte-identical in both agent guides and states what scaffold does', () => {
  const canonical = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');
  const canonicalBullets = handFinishedRegistryDefinitionBullets(canonical);
  const guideBullets = handFinishedRegistryDefinitionBullets(guide);
  assert.equal(canonicalBullets.length, 1, 'for-ai-agents.md must carry exactly one hand-finished registry definition bullet');
  assert.equal(guideBullets.length, 1, 'AGENT-MAINTENANCE-GUIDE.md must carry exactly one hand-finished registry definition bullet');
  assert.equal(guideBullets[0], canonicalBullets[0], 'the hand-finished registry definition must be byte-identical in both agent guides');
  // What the code does: scaffold refuses any existing spec without --force, declared or not
  // (src/cli/verbs/scaffold.ts); declaring adds the notice and makes fix-selector --apply refuse.
  assert.ok(
    canonicalBullets[0]!.includes('`scaffold` refuses to overwrite any existing spec unless you pass `--force`, whether or not its slug is declared there.'),
    'the definition must say scaffold refuses every existing spec without --force, declared or not',
  );
  assert.ok(
    canonicalBullets[0]!.includes('makes `fix-selector --apply` refuse that spec'),
    'the definition must say declaring a slug makes fix-selector --apply refuse that spec',
  );
  assert.doesNotMatch(canonicalBullets[0]!, /protected only if/i, 'declaring a slug is not what protects a spec from scaffold');
});

test('AGENT-MAINTENANCE-GUIDE.md CI workflow mirrors the canonical workflow', () => {
  const canonical = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENT-MAINTENANCE-GUIDE.md'), 'utf8');
  const yamlBlock = /```yaml\n([\s\S]*?)\n```/;
  const canonicalWorkflow = yamlBlock.exec(canonical)?.[1];
  const guideWorkflow = yamlBlock.exec(guide)?.[1];
  assert.ok(canonicalWorkflow !== undefined, 'for-ai-agents.md is missing its CI workflow');
  assert.ok(guideWorkflow !== undefined, 'AGENT-MAINTENANCE-GUIDE.md is missing its CI workflow');
  assert.equal(guideWorkflow, canonicalWorkflow, 'the two customer maintenance guides must carry identical CI workflow snippets');
  assert.match(canonicalWorkflow, /--reporter=json,\.\/node_modules\/replaytest\/dist\/heal-run-hashes-reporter\.js/);
});

test('for-ai-agents.md Part 2 --json map covers exactly the JSON-capable command set', (t) => {
  if (!fs.existsSync(path.join(docsSiteDirectory, 'for-ai-agents.md'))) {
    t.skip('for-ai-agents.md does not exist yet; the --json-map parity check activates when the docs land.');
    return;
  }

  const jsonCapable = jsonCapableCommandsFromHelpFixture();
  assert.ok(jsonCapable.length > 0, 'parsed no [--json] commands from cli-help.txt — the usage-line parser has drifted');

  const mapCommands = jsonMapCommands(docsSiteDirectory);

  const missing = jsonCapable.filter((command) => !mapCommands.includes(command));
  assert.deepEqual(
    missing,
    [],
    `for-ai-agents.md Part 2 --json map is missing a row for: ${missing.join(', ')}. Every command whose --help advertises [--json] must have a row in the capability map.`,
  );

  const phantom = mapCommands.filter((command) => !jsonCapable.includes(command));
  assert.deepEqual(
    phantom,
    [],
    `for-ai-agents.md Part 2 --json map has a row for a command that does not accept --json: ${phantom.join(', ')}. Remove the stale row, or the command lost its [--json] flag.`,
  );
});

test('for-ai-agents.md Part 2 count sentences match the derived command tallies', (t) => {
  if (!fs.existsSync(path.join(docsSiteDirectory, 'for-ai-agents.md'))) {
    t.skip('for-ai-agents.md does not exist yet; the count-sentence check activates when the docs land.');
    return;
  }

  const jsonCount = jsonCapableCommandsFromHelpFixture().length;
  // The help text lists `help` beside the verbs; the pages count verbs, which is the CLI's own verb registry.
  const totalCount = cliCommandsFromHelpFixture().filter((command) => command !== 'help').length;
  assert.equal(totalCount, CLI_VERBS.length, 'the help-text verbs and the CLI verb registry must agree');
  const markdown = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const part2 = markdown.slice(markdown.indexOf('## Part 2'));

  const introSentence = `${capitalize(numberToWords(jsonCount))} of the ${numberToWords(totalCount)} CLI verbs accept \`--json\``;
  assert.ok(
    part2.includes(introSentence),
    `for-ai-agents.md Part 2 intro count is stale — expected it to open "${introSentence}" (${jsonCount} JSON-capable of ${totalCount} CLI verbs).`,
  );
  const cliReference = fs.readFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), 'utf8');
  assert.ok(
    cliReference.includes(`Of the ${totalCount} CLI verbs,`),
    `cli-reference.md must open its verb tally with "Of the ${totalCount} CLI verbs," — the same count for-ai-agents.md states.`,
  );

  const envelopesSentence = `All ${numberToWords(jsonCount)} envelopes allow new fields`;
  assert.ok(
    part2.includes(envelopesSentence),
    `for-ai-agents.md Part 2 stability sentence is stale — expected "${envelopesSentence}" (${jsonCount} JSON-capable envelopes).`,
  );

  const anyOfThese = `on any of these ${numberToWords(jsonCount)}`;
  assert.ok(
    part2.includes(anyOfThese),
    `for-ai-agents.md Part 2 "read the live output" sentence is stale — expected "${anyOfThese}" (${jsonCount} JSON-capable commands).`,
  );
});

test('feature-docs currency guard covers README flags, cli-reference flags, and JSON envelope fields', () => {
  assertFeatureDocsCurrency(repoRoot);
});

test('the dashboard guide states the footer rule for requested and automatic PostHog contact', () => {
  const guide = fs.readFileSync(path.join(docsSiteDirectory, 'dashboard-guide.md'), 'utf8');
  assert.ok(guide.includes('The page footer says when the dashboard contacts PostHog: when you ask for new data, on its own to check that replays are still available, when an auto-check schedule you set runs, and when the stored data does not cover what you are viewing.'), 'the dashboard guide must retain the complete footer contact rule');
});

test('docs fixture: unreadable inventory remains an explicit, non-green state on every customer surface', () => {
  const forAi = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const cliReference = fs.readFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), 'utf8');
  const concepts = fs.readFileSync(path.join(docsSiteDirectory, 'concepts.md'), 'utf8');
  const dashboard = fs.readFileSync(path.join(docsSiteDirectory, 'dashboard-guide.md'), 'utf8');
  assert.match(forAi, /inventoryDisclosure/);
  assert.match(forAi, /unreadable-spec/);
  assert.match(forAi, /The generated spec exists but could not be read\./);
  assert.equal(
    forAi.split('could not be read or exceeded the byte budget').length - 1,
    2,
    'sessions and gaps docs must say that suiteScan.unreadableFiles also counts oversized files',
  );
  assert.match(cliReference, /unreadable-spec/);
  assert.match(concepts, /unknown lifecycle and reason/);
  assert.match(dashboard, /separate `ⓘ couldn't verify` disclosure/);
});

test('feature-docs currency guard fires on a disposable README copy with a missing featured command row', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });

  const sessionsRow = '| `sessions` | Groups recorded sessions into journeys and ranks them by how many sessions took each one |\n';
  const original = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.equal(original.split(sessionsRow).length - 1, 1, 'the planted defect must remove exactly one real Commands row');
  const readme = original.replace(sessionsRow, '');
  fs.writeFileSync(path.join(disposableRoot, 'README.md'), readme, 'utf8');
  for (const name of ['cli-reference.md', 'for-ai-agents.md']) {
    fs.copyFileSync(path.join(docsSiteDirectory, name), path.join(disposableDocs, name));
  }

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /Commands table is missing the sessions row/,
  );
});

test('feature-docs currency guard fires when another featured command row is dropped from the README Commands section', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-held-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });

  const planRow = '| `plan <distinctId>` | Writes a plain-English test plan for each finished journey in one session from that user (choose which with `--session`) |\n';
  const original = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.equal(original.split(planRow).length - 1, 1, 'the planted defect must remove exactly one real Commands row');
  const readme = original.replace(planRow, '');
  fs.writeFileSync(path.join(disposableRoot, 'README.md'), readme, 'utf8');
  for (const name of ['cli-reference.md', 'for-ai-agents.md']) {
    fs.copyFileSync(path.join(docsSiteDirectory, name), path.join(disposableDocs, name));
  }

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /Commands table is missing the plan row/,
  );
});

test('feature-docs currency guard rejects a stale explain envelope-kind count', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(disposableRoot, 'README.md'));
  const cliReference = fs.readFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), 'utf8')
    .replace(EXPLAIN_JSON_CLI_CONTRACT_SENTENCE, EXPLAIN_JSON_CLI_CONTRACT_SENTENCE.replace('ambiguous-code forms remain versioned', 'ambiguous-code and usage-error forms remain versioned'));
  fs.writeFileSync(path.join(disposableDocs, 'cli-reference.md'), cliReference, 'utf8');
  fs.copyFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), path.join(disposableDocs, 'for-ai-agents.md'));

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /cli-reference\.md must document the four versioned explain kinds and shared unversioned usage-error shape/,
  );
});

test('feature-docs currency guard rejects an undocumented explain message-template convention', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(disposableRoot, 'README.md'));
  fs.copyFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), path.join(disposableDocs, 'cli-reference.md'));
  const forAi = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8')
    .replace(EXPLAIN_MESSAGE_TEMPLATE_FOR_AI, 'For a resolved entry, `message` is available.');
  fs.writeFileSync(path.join(disposableDocs, 'for-ai-agents.md'), forAi, 'utf8');

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /for-ai-agents\.md explain --json row must explain that message values are exact templates with runtime interpolation markers/,
  );
});

test('feature-docs currency guard sees conditional coarse JSON fields and rejects an undocumented one', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(disposableRoot, 'README.md'));
  fs.copyFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), path.join(disposableDocs, 'cli-reference.md'));
  const forAi = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8')
    .replace('scanMode?, backfillEstimate?, projectWideScan?', 'scanMode?');
  fs.writeFileSync(path.join(disposableDocs, 'for-ai-agents.md'), forAi, 'utf8');

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /sessions --json schema is missing emitted top-level field\(s\): backfillEstimate, projectWideScan/,
  );
});

test('feature-docs currency guard fires on a disposable docs copy with a missing enriched nested path', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-nested-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(disposableRoot, 'README.md'));
  fs.copyFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), path.join(disposableDocs, 'cli-reference.md'));

  const currentForAi = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const nestedPath = 'suiteScan.cappedBy';
  assert.equal(currentForAi.split(nestedPath).length - 1, 1, 'the planted nested drift must target one documented literal');
  fs.writeFileSync(
    path.join(disposableDocs, 'for-ai-agents.md'),
    currentForAi.replace(nestedPath, 'suiteScan.notDocumentedCap'),
    'utf8',
  );

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /sessions --json schema is missing emitted top-level field\(s\): suiteScan\.cappedBy/,
  );
});

test('feature-docs currency guard fires when the relocated-spec field is removed from its heal/suite-status documentation rows', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-relocated-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(disposableRoot, 'README.md'));
  fs.copyFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), path.join(disposableDocs, 'cli-reference.md'));
  const forAi = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8')
    .replaceAll('drift.relocatedSpec', 'drift.notDocumentedRelocation');
  fs.writeFileSync(path.join(disposableDocs, 'for-ai-agents.md'), forAi, 'utf8');

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /heal --json schema is missing emitted top-level field\(s\): drift\.relocatedSpec/,
  );
});

test('feature-docs currency guard fires when suite-status generated-spec partiality loses its unassessed-slug field', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-suite-status-scan-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'README.md'), path.join(disposableRoot, 'README.md'));
  fs.copyFileSync(path.join(docsSiteDirectory, 'cli-reference.md'), path.join(disposableDocs, 'cli-reference.md'));
  const currentForAi = fs.readFileSync(path.join(docsSiteDirectory, 'for-ai-agents.md'), 'utf8');
  const nestedPath = 'generatedSpecScan.unassessedSlugs';
  assert.equal(currentForAi.split(nestedPath).length - 1, 1, 'the planted nested partiality drift must target one documented literal');
  fs.writeFileSync(
    path.join(disposableDocs, 'for-ai-agents.md'),
    currentForAi.replace(nestedPath, 'generatedSpecScan.notDocumentedSlugs'),
    'utf8',
  );

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /suite-status --json schema is missing emitted top-level field\(s\): generatedSpecScan\.unassessedSlugs/,
  );
});

test('feature-docs currency guard fires when the README Commands heading is renamed', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });

  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
    .replace('## 🧰 Commands', '## 🧰 Verbs');
  fs.writeFileSync(path.join(disposableRoot, 'README.md'), readme, 'utf8');
  for (const name of ['cli-reference.md', 'for-ai-agents.md']) {
    fs.copyFileSync(path.join(docsSiteDirectory, name), path.join(disposableDocs, name));
  }

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /is missing its "## 🧰 Commands" heading/,
  );
});

test('feature-docs currency guard fires on a disposable README copy with a missing complete-flags pointer', (t: TestContext) => {
  const disposableRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-docs-currency-'));
  const disposableDocs = path.join(disposableRoot, 'docs', 'site');
  fs.mkdirSync(disposableDocs, { recursive: true });

  const pointer = 'Every command and flag: [CLI reference](docs/site/cli-reference.md).';
  const original = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.equal(original.split(pointer).length - 1, 1, 'the planted defect must remove the one real complete-flags pointer');
  const readme = original.replace(pointer, 'See the CLI reference.');
  fs.writeFileSync(path.join(disposableRoot, 'README.md'), readme, 'utf8');
  for (const name of ['cli-reference.md', 'for-ai-agents.md']) {
    fs.copyFileSync(path.join(docsSiteDirectory, name), path.join(disposableDocs, name));
  }

  assert.throws(
    () => assertFeatureDocsCurrency(disposableRoot),
    /complete-flags pointer/,
  );
});

/**
 * Every shipped journey-status class, read from the one in-code copy source
 * rather than re-listed here. A new class therefore fails every documented
 * status enumeration until the docs name it, and a retired one fails the
 * enumerations that still name it.
 */
const SHIPPED_JOURNEY_STATUSES: readonly string[] = COMPLETION_EVIDENCE_LADDER.map((entry) => entry.status);

/**
 * The subset of classes that ships as an outcome checkbox on the dashboard's
 * Sessions tab, read from the dashboard asset. Not every class has a checkbox,
 * so a page listing exactly the checkboxes is a complete list in its own right
 * — but it is complete against the shipped controls, not against a hand-kept
 * copy of them.
 */
function dashboardStatusFilterClasses(): string[] {
  const asset = fs.readFileSync(path.join(repoRoot, 'src', 'dashboard', 'index.html'), 'utf8');
  return SHIPPED_JOURNEY_STATUSES.filter((status) => asset.includes(`id="filter-${status}"`));
}

/** How many words may sit between two enumerated statuses (`completed / likely submitted`) before they read as separate statements. */
const STATUS_ENUMERATION_MAX_GLUE_WORDS = 1;

const STATUS_ENUMERATION_HINT =
  'A journey-status enumeration must name every shipped class (the ladder in src/completion-evidence.ts), or exactly the dashboard outcome checkboxes';

/**
 * Prose only. Generated fixture blocks and fenced samples are rendered from
 * code and already held byte-for-byte by the staleness check above, and
 * `--flag` spellings are CLI surface rather than prose — only some classes have
 * a filter flag, so a flag list is not a claim about the class set.
 */
function documentationProse(markdown: string): string {
  return markdown
    .replace(/<!-- fixture:[\s\S]*?<!-- \/fixture -->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/--[a-z][a-z0-9-]*/g, ' ');
}

export interface StatusEnumeration {
  statuses: string[];
  text: string;
}

/**
 * Every run of two or more journey-status names read as one list — adjacent in
 * the prose, separated only by punctuation, a joining word, or a single
 * qualifier ("completed / likely submitted / abandoned"). A status named on its
 * own, or a sentence away from the next one, is ordinary prose and is left
 * alone.
 */
export function statusEnumerations(markdown: string, statuses: readonly string[]): StatusEnumeration[] {
  const words = documentationProse(markdown).toLowerCase().match(/[a-z][a-z']*/g) ?? [];
  const statusSet = new Set(statuses);
  const enumerations: StatusEnumeration[] = [];
  let run: Array<{ status: string; at: number }> = [];

  const flush = (): void => {
    if (run.length > 1) {
      enumerations.push({
        statuses: [...new Set(run.map((entry) => entry.status))],
        text: words.slice(run[0].at, run[run.length - 1].at + 1).join(' '),
      });
    }
    run = [];
  };

  for (const [at, word] of words.entries()) {
    if (!statusSet.has(word)) continue;
    const previous = run[run.length - 1];
    if (previous !== undefined && at - previous.at - 1 > STATUS_ENUMERATION_MAX_GLUE_WORDS) flush();
    run.push({ status: word, at });
  }
  flush();

  return enumerations;
}

/** Fails when a documented status list silently drops a shipped class. */
export function assertStatusEnumerations(
  markdown: string,
  sourcePath: string,
  statuses: readonly string[],
  filterClasses: readonly string[],
): StatusEnumeration[] {
  const enumerations = statusEnumerations(markdown, statuses);
  for (const enumeration of enumerations) {
    const named = new Set(enumeration.statuses);
    const namesEveryClass = statuses.every((status) => named.has(status));
    const namesEveryFilter = named.size === filterClasses.length && filterClasses.every((status) => named.has(status));
    if (namesEveryClass || namesEveryFilter) continue;
    const missing = statuses.filter((status) => !named.has(status));
    assert.fail(
      `${sourcePath} lists journey statuses as "${enumeration.text}" but is missing: ${missing.join(', ')}. ${STATUS_ENUMERATION_HINT}.`,
    );
  }
  return enumerations;
}

test('docs/site journey-status enumerations name every shipped status class', () => {
  assert.ok(SHIPPED_JOURNEY_STATUSES.length > 0, 'read no journey statuses from the completion-evidence ladder');
  const filterClasses = dashboardStatusFilterClasses();
  assert.ok(
    filterClasses.length > 0,
    'read no outcome checkboxes from the dashboard asset — the filter-id reader has drifted from the shipped controls',
  );

  let found = 0;
  for (const markdownPath of findMarkdownFiles(docsSiteDirectory)) {
    found += assertStatusEnumerations(
      fs.readFileSync(markdownPath, 'utf8'),
      path.relative(repoRoot, markdownPath),
      SHIPPED_JOURNEY_STATUSES,
      filterClasses,
    ).length;
  }
  assert.ok(found > 0, 'found no journey-status enumeration anywhere in docs/site — the enumeration reader has drifted');
});

test('journey-status enumeration guard rejects a list that drops a shipped class', () => {
  const filterClasses = dashboardStatusFilterClasses();
  const guide = fs.readFileSync(path.join(docsSiteDirectory, 'dashboard-guide.md'), 'utf8');
  const dropped = guide.replace(
    'Those two figures count the two kinds of journey the tool can turn into a plan; every journey still appears in the table.',
    'The count line lists completed / likely submitted / abandoned outcomes; every journey still appears in the table.',
  );
  assert.notEqual(dropped, guide, 'the guarded dashboard-guide status list has been reworded; update this drift case with it');
  assert.throws(
    () => assertStatusEnumerations(dropped, 'dropped-status', SHIPPED_JOURNEY_STATUSES, filterClasses),
    /missing: navigated/,
  );

  assert.doesNotThrow(
    () => assertStatusEnumerations('Filters: completed / navigated / submitted, time window.', 'checkbox-list', SHIPPED_JOURNEY_STATUSES, filterClasses),
    'the dashboard outcome checkboxes are a complete list of the shipped controls',
  );
  assert.doesNotThrow(
    () => assertStatusEnumerations('`sessions [--completed] [--submitted]`', 'flag-list', SHIPPED_JOURNEY_STATUSES, filterClasses),
    'a CLI flag list is not a prose claim about the class set',
  );
  assert.deepEqual(
    statusEnumerations('It completed a form submit, or typed into a field and abandoned nothing.', SHIPPED_JOURNEY_STATUSES),
    [],
    'statuses a sentence apart are ordinary prose, not a list',
  );
});

test('fixture scanner reads persistent sample blocks without changing their bytes', () => {
  const blocks = scanFixtureBlocks(fs.readFileSync(scannerSamplePath, 'utf8'), scannerSamplePath);
  assert.deepEqual(blocks, [
    { fixtureName: 'sample-output', content: 'first line\nsecond line\n', line: 3 },
    { fixtureName: 'sample-empty', content: '', line: 10 },
  ]);
});

test('customer docs fixture blocks and safe CLI fixtures are current', (t) => {
  if (!fs.existsSync(docsSiteDirectory)) {
    t.skip('docs/site does not exist yet; fixture checks will activate when the docs land.');
    return;
  }

  const markdownFiles = findMarkdownFiles(docsSiteDirectory);
  const blocks = allFixtureBlocks(markdownFiles);
  if (blocks.length === 0) {
    t.skip('docs/site has no fixture blocks yet; fixture checks will activate when the docs land.');
    return;
  }

  const safeFixtureNames = new Set(SAFE_CLI_FIXTURES.map((fixture) => fixture.name));
  for (const block of blocks) {
    assert.ok(
      safeFixtureNames.has(block.fixtureName),
      `${path.relative(repoRoot, block.markdownPath)}:${block.line} embeds fixture:${block.fixtureName}, which is not in the safe allow-list. Only allow-listed CLI fixtures may be embedded — a new verb needs its --help handling inspected and added to SAFE_CLI_FIXTURES deliberately before its output can be embedded here.`,
    );
    const fixturePath = path.join(CLI_FIXTURES_DIRECTORY, `${block.fixtureName}.txt`);
    assert.ok(
      fs.existsSync(fixturePath),
      `${path.relative(repoRoot, block.markdownPath)}:${block.line} references missing ${path.relative(repoRoot, fixturePath)}`,
    );
    assert.equal(
      fs.readFileSync(fixturePath, 'utf8'),
      block.content,
      `${path.relative(repoRoot, block.markdownPath)}:${block.line} is stale for fixture:${block.fixtureName}`,
    );
  }

  const allowedFixtureNames = new Set(SAFE_CLI_FIXTURES.map((fixture) => fixture.name));
  const actualCliFixtureNames = fs
    .readdirSync(CLI_FIXTURES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^cli-help(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.txt$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -'.txt'.length))
    .sort();
  assert.deepEqual(
    actualCliFixtureNames,
    [...allowedFixtureNames].sort(),
    'Only the safe CLI fixtures may exist. A new verb needs its --help handling inspected and added to SAFE_CLI_FIXTURES deliberately before a fixture for it can exist here.',
  );

  const freshOutputs = generateCliFixtureOutputs();
  for (const [fixtureName, output] of freshOutputs) {
    const fixturePath = path.join(CLI_FIXTURES_DIRECTORY, `${fixtureName}.txt`);
    assert.ok(fs.existsSync(fixturePath), `Missing safe CLI fixture ${path.relative(repoRoot, fixturePath)}`);
    assert.equal(fs.readFileSync(fixturePath, 'utf8'), output, `${path.relative(repoRoot, fixturePath)} is stale`);
  }
});
