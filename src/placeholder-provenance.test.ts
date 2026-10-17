/**
 * Placeholder provenance is a three-projection contract: new sidecars expose
 * a machine-readable field, while Markdown and specs make every fabricated
 * typed value visible to human reviewers. Older sidecars remain honest even
 * before they are regenerated.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  PLACEHOLDER_VALUE_EXPLANATION,
  PLACEHOLDER_VALUE_MARKER,
  usesPlaceholderValue,
} from './repro-builder.js';
import { hashSpecContent } from './heal-run-hashes.js';
import { handFinishedRegistryPath, parseHandFinishedRegistry } from './hand-finished.js';
import {
  RENDERER_HONESTY_MARKER_CODES,
  rendererHonestyMarkers,
  renderPlanMarkdown,
  renderScaffoldSpec,
  SPEC_HONESTY_MARKER_PREFIX,
  type RendererHonestyMarkerCode,
  type Sidecar,
} from './sidecar.js';
import { readSpecEmittedHashes, specEmittedHashesPath, type SpecEmittedHashEntry } from './spec-emitted-hashes.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function sidecar(placeholder?: true): Sidecar {
  return {
    version: 1,
    title: 'Placeholder provenance',
    source: {
      distinctId: 'person@example.test',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: '/start > /done',
      generatedAt: '2026-08-11T00:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/start',
    steps: [
      {
        action: 'fill',
        label: 'Email',
        locator: "getByLabel('Email')",
        inputType: 'email',
        ...(placeholder === undefined ? {} : { placeholder }),
      },
      {
        action: 'fill',
        label: 'Category',
        locator: "getByLabel('Category')",
        elementTag: 'select',
      },
      {
        action: 'fill',
        label: 'Subscribe',
        locator: "getByLabel('Subscribe')",
        inputType: 'checkbox',
      },
    ],
    assertions: [],
  };
}

test('placeholder provenance: a new typed fill carries the field and all three rendered surfaces agree on the shared marker', () => {
  const built = sidecar(true);
  const typedFill = built.steps[0];
  assert.equal(typedFill?.placeholder, true);

  const markdown = renderPlanMarkdown(built);
  const spec = renderScaffoldSpec(built, 'placeholder-provenance');
  assert.match(markdown, new RegExp(`Fill in the "Email" field \\(${PLACEHOLDER_VALUE_MARKER}\\)`));
  assert.match(spec, new RegExp(`fill\\('test@example\\.com'\\); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — ${PLACEHOLDER_VALUE_MARKER}`));
  assert.equal(markdown.split(PLACEHOLDER_VALUE_EXPLANATION).length - 1, 1);
  assert.equal(spec.split(PLACEHOLDER_VALUE_EXPLANATION).length - 1, 1);

  // These are witnessed select/check interactions, not fabricated typed
  // values: the label must not overclaim their evidence.
  assert.match(spec, /selectOption\(\{ index: 1 \}\)/);
  assert.match(spec, /\.check\(\)/);
  assert.doesNotMatch(markdown, /Category" field \(placeholder value\)/);
  assert.doesNotMatch(markdown, /Subscribe" field \(placeholder value\)/);
});

test('placeholder provenance: old sidecars without the additive field still render the universal disclosure', () => {
  const legacy = sidecar();
  assert.equal(Object.hasOwn(legacy.steps[0]!, 'placeholder'), false);
  assert.match(renderPlanMarkdown(legacy), new RegExp(PLACEHOLDER_VALUE_MARKER));
  assert.match(renderScaffoldSpec(legacy, 'legacy-placeholder'), new RegExp(PLACEHOLDER_VALUE_MARKER));
});

test('placeholder provenance: a locator-less typed fill remains visibly marked in Markdown', () => {
  const locatorless = sidecar(true);
  locatorless.steps[0]!.locator = '';

  const markdown = renderPlanMarkdown(locatorless);
  assert.match(markdown, new RegExp(`Fill in the "Email" field \\(${PLACEHOLDER_VALUE_MARKER}\\)`));
  assert.doesNotMatch(markdown, /Fill in the "Email" field \(placeholder value\) `/);
  assert.equal(markdown.split(PLACEHOLDER_VALUE_EXPLANATION).length - 1, 1);
});

// Coverage boundary: this guard walks the FROZEN corpus on disk (goldens + tracked live
// plans) and re-renders it — it proves surface agreement over that corpus, not that the
// live emitter still stamps the field on new sessions (emitter drift is eval:check's job).
test('placeholder provenance guard: every freshly generated fixture fill is structurally marked and all projections agree', () => {
  const sidecarPaths = [
    ...fs.readdirSync(path.join(repoRoot, 'archive', 'goldens'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const directory = path.join(repoRoot, 'archive', 'goldens', entry.name);
        return fs.readdirSync(directory)
          .filter((name) => name.endsWith('.plan.json'))
          .map((name) => path.join(directory, name));
      }),
    ...['appt-6', 'customer-created', 'invoice-confirmation', 'invoices-inv-1003']
      .map((slug) => path.join(repoRoot, '.replaytest', 'plans', `${slug}.plan.json`)),
  ];

  for (const sidecarPath of sidecarPaths) {
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar;
    const placeholderFills = sidecar.steps.filter(
      (step) => step.action === 'fill' && usesPlaceholderValue(step.elementTag, step.inputType),
    );
    for (const step of placeholderFills) {
      assert.equal(step.placeholder, true, `${path.relative(repoRoot, sidecarPath)}: ${step.label}`);
    }
    for (const step of sidecar.steps) {
      if (step.action !== 'fill' || usesPlaceholderValue(step.elementTag, step.inputType)) continue;
      assert.equal(step.placeholder, undefined, `${path.relative(repoRoot, sidecarPath)}: ${step.label}`);
    }

    const markdown = renderPlanMarkdown(sidecar);
    const spec = renderScaffoldSpec(sidecar, path.basename(sidecarPath, '.plan.json'));
    const markdownMarkers = markdown.match(/\(placeholder value\)/g) ?? [];
    const specMarkers = spec.match(/replaytest-marker: placeholder-value — placeholder value/g) ?? [];
    // The scaffold emits a "no selector recoverable" TODO instead of a fill line when a
    // step has no locator, so only locator-bearing fills can carry the spec marker; the
    // Markdown marker follows the value's provenance regardless of locator.
    const locatorBearingFills = placeholderFills.filter((step) => step.locator !== '');
    assert.equal(markdownMarkers.length, placeholderFills.length, `${path.relative(repoRoot, sidecarPath)} Markdown`);
    assert.equal(specMarkers.length, locatorBearingFills.length, `${path.relative(repoRoot, sidecarPath)} scaffold`);
    assert.equal(
      markdown.split(PLACEHOLDER_VALUE_EXPLANATION).length - 1,
      placeholderFills.length === 0 ? 0 : 1,
      `${path.relative(repoRoot, sidecarPath)} Markdown explanation`,
    );
    assert.equal(
      spec.split(PLACEHOLDER_VALUE_EXPLANATION).length - 1,
      placeholderFills.length === 0 ? 0 : 1,
      `${path.relative(repoRoot, sidecarPath)} scaffold explanation`,
    );
  }
});

interface WorkspaceGeneratedSpec {
  slug: string;
  specPath: string;
}

/** A spec finished by hand after generation cannot honestly carry a machine-write hash attestation. */
interface HandFinishedCarveOut {
  slug: string;
  since: string;
  reason: string;
}

/** A spec awaiting a user disposition is disclosed, not silently excluded. */
interface PendingParitySpec {
  slug: string;
  since: string;
  reason: string;
  surfacing: string;
}

interface SpecAccountingPolicy {
  carveOuts: readonly HandFinishedCarveOut[];
  pending: readonly PendingParitySpec[];
  /**
   * Slugs whose emitted-hash stamp lives in the untracked runtime store. The store never
   * ships to stage/CI checkouts, so on a store-less tree these specs defer (disclosed)
   * instead of going RED — while any spec NOT on this roster still fails the floor there.
   * On a store-bearing tree the roster is cross-checked against the store both ways.
   */
  stampedRoster: readonly string[];
}

const parsedHandFinishedRegistry = parseHandFinishedRegistry(fs.readFileSync(handFinishedRegistryPath(repoRoot), 'utf8'));
if ('error' in parsedHandFinishedRegistry) throw new Error(parsedHandFinishedRegistry.error);
const HAND_FINISHED_CARVE_OUTS: readonly HandFinishedCarveOut[] = parsedHandFinishedRegistry.entries;

const PENDING_PARITY_SPECS: readonly PendingParitySpec[] = [];

const STAMPED_ROSTER: readonly string[] = ['customer-created'];

const LIVE_SPEC_ACCOUNTING_POLICY: SpecAccountingPolicy = {
  carveOuts: HAND_FINISHED_CARVE_OUTS,
  pending: PENDING_PARITY_SPECS,
  stampedRoster: STAMPED_ROSTER,
};

interface StampedGeneratedSpec extends WorkspaceGeneratedSpec {
  entry: SpecEmittedHashEntry;
}

interface DuplicateWorkspaceStoreEntry extends WorkspaceGeneratedSpec {
  entryCount: number;
}

interface UnaccountedGeneratedSpec extends WorkspaceGeneratedSpec {
  reason:
    | 'no emitter hash, carve-out, or pending disposition'
    | 'multiple dispositions'
    | 'stamped-roster spec has no workspace store entry on a store-bearing tree';
}

interface GeneratedSpecAccounting {
  /** Every workspace-resident store entry, including stale entries with no current spec file. */
  workspaceStoreEntries: SpecEmittedHashEntry[];
  stamped: StampedGeneratedSpec[];
  carved: HandFinishedCarveOut[];
  pending: PendingParitySpec[];
  /** Roster members without a runtime hash store are reported as deferred, not failed. */
  deferredStampedRoster: WorkspaceGeneratedSpec[];
  unexplained: UnaccountedGeneratedSpec[];
  obsoleteCarveOuts: HandFinishedCarveOut[];
  obsoletePending: PendingParitySpec[];
  /** Roster slugs with no current spec file: a stale attestation is RED, mirroring carve/pending. */
  obsoleteStampedRoster: string[];
  /** Store-stamped specs missing from the tracked roster: the roster must enumerate exactly. */
  unrosteredStamped: WorkspaceGeneratedSpec[];
  duplicateStoreEntries: DuplicateWorkspaceStoreEntry[];
}

interface MarkerAudit {
  checked: string[];
  /** Hash-record entries that resolve outside this workspace never belong to its emitted-spec audit. */
  excludedOutsideWorkspace: string[];
  /** Workspace-resident sources whose content still matches the emitter record. */
  matchingHashSources: string[];
  missing: Array<{ specPath: string; marker: RendererHonestyMarkerCode }>;
  outOfParityScope: Array<{ specPath: string; reason: string }>;
}

/** A hash record is emitter-owned only for a descendant of this workspace's canonical generated-spec directory. */
function isWorkspaceEmittedSpecPath(workspaceRoot: string, specPath: string): boolean {
  const generatedTestsDir = path.resolve(workspaceRoot, 'tests', 'generated');
  const resolvedSpecPath = path.resolve(workspaceRoot, specPath);
  const relative = path.relative(generatedTestsDir, resolvedSpecPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Enumerates the canonical generated-spec population; store entries alone cannot reveal an unstamped spec. */
function walkWorkspaceGeneratedSpecs(workspaceRoot: string): WorkspaceGeneratedSpec[] {
  const generatedTestsDir = path.join(workspaceRoot, 'tests', 'generated');
  return fs.readdirSync(generatedTestsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => ({
      slug: entry.name.slice(0, -'.spec.ts'.length),
      specPath: path.relative(workspaceRoot, path.join(generatedTestsDir, entry.name)),
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/**
 * Accounts for every generated spec exactly once. This is the always-live structural
 * floor: an unstamped spec must be a named carve-out or a pending decision, never
 * an unreported hole in the parity audit.
 */
function accountGeneratedSpecs(
  workspaceRoot: string,
  specs: readonly WorkspaceGeneratedSpec[],
  entries: readonly SpecEmittedHashEntry[],
  /**
   * Whether a readable store FILE exists on this tree — deliberately not derived from
   * `entries` contents: a store holding only out-of-workspace (stale temp) entries is
   * still store-BEARING, so roster↔store drift must RED there, never defer.
   */
  storePresent: boolean,
  policy: SpecAccountingPolicy = LIVE_SPEC_ACCOUNTING_POLICY,
): GeneratedSpecAccounting {
  const workspaceStoreEntries = entries.filter((entry) => isWorkspaceEmittedSpecPath(workspaceRoot, entry.specPath));
  const entriesByResolvedPath = new Map<string, SpecEmittedHashEntry[]>();
  for (const entry of workspaceStoreEntries) {
    const resolvedPath = path.resolve(workspaceRoot, entry.specPath);
    const matching = entriesByResolvedPath.get(resolvedPath) ?? [];
    matching.push(entry);
    entriesByResolvedPath.set(resolvedPath, matching);
  }

  const knownSlugs = new Set(specs.map((spec) => spec.slug));
  const storeless = !storePresent;
  const accounting: GeneratedSpecAccounting = {
    workspaceStoreEntries,
    stamped: [],
    carved: [],
    pending: [],
    deferredStampedRoster: [],
    unexplained: [],
    obsoleteCarveOuts: policy.carveOuts.filter((entry) => !knownSlugs.has(entry.slug)),
    obsoletePending: policy.pending.filter((entry) => !knownSlugs.has(entry.slug)),
    obsoleteStampedRoster: policy.stampedRoster.filter((slug) => !knownSlugs.has(slug)),
    unrosteredStamped: [],
    duplicateStoreEntries: [],
  };

  for (const spec of specs) {
    const matchingEntries = entriesByResolvedPath.get(path.resolve(workspaceRoot, spec.specPath)) ?? [];
    if (matchingEntries.length > 1) {
      accounting.duplicateStoreEntries.push({ ...spec, entryCount: matchingEntries.length });
    }
    const carveOut = policy.carveOuts.find((entry) => entry.slug === spec.slug);
    const pending = policy.pending.find((entry) => entry.slug === spec.slug);
    const rosterMember = policy.stampedRoster.includes(spec.slug);
    // The roster attests "stamped via the store"; combined with a carve-out or pending row it is a contradiction.
    const dispositionCount = Number(matchingEntries.length > 0) + Number(carveOut !== undefined) + Number(pending !== undefined);
    if (rosterMember && (carveOut !== undefined || pending !== undefined)) {
      accounting.unexplained.push({ ...spec, reason: 'multiple dispositions' });
      continue;
    }
    if (dispositionCount === 1) {
      if (matchingEntries.length > 0) {
        accounting.stamped.push({ ...spec, entry: matchingEntries[0]! });
        if (!rosterMember) accounting.unrosteredStamped.push(spec);
      } else if (carveOut !== undefined) accounting.carved.push(carveOut);
      else accounting.pending.push(pending!);
      continue;
    }
    if (dispositionCount === 0 && rosterMember) {
      if (storeless) accounting.deferredStampedRoster.push(spec);
      else accounting.unexplained.push({ ...spec, reason: 'stamped-roster spec has no workspace store entry on a store-bearing tree' });
      continue;
    }
    accounting.unexplained.push({
      ...spec,
      reason: dispositionCount === 0 ? 'no emitter hash, carve-out, or pending disposition' : 'multiple dispositions',
    });
  }
  return accounting;
}

function assertGeneratedSpecStructuralFloor(accounting: GeneratedSpecAccounting): void {
  assert.deepEqual(
    accounting.unexplained,
    [],
    `Generated-spec accounting has unexplained spec(s): ${accounting.unexplained.map((entry) => `${entry.slug} (${entry.reason})`).join(', ')}`,
  );
  assert.deepEqual(
    accounting.obsoleteCarveOuts,
    [],
    `Generated-spec accounting has obsolete hand-finished carve-out(s): ${accounting.obsoleteCarveOuts.map((entry) => entry.slug).join(', ')}`,
  );
  assert.deepEqual(
    accounting.obsoletePending,
    [],
    `Generated-spec accounting has obsolete pending disposition(s): ${accounting.obsoletePending.map((entry) => entry.slug).join(', ')}`,
  );
  assert.deepEqual(
    accounting.obsoleteStampedRoster,
    [],
    `Generated-spec accounting has obsolete stamped-roster slug(s): ${accounting.obsoleteStampedRoster.join(', ')}`,
  );
  assert.deepEqual(
    accounting.unrosteredStamped,
    [],
    `Generated-spec accounting has store-stamped spec(s) missing from the tracked stamped roster: ${accounting.unrosteredStamped.map((entry) => entry.slug).join(', ')}`,
  );
  assert.deepEqual(
    accounting.duplicateStoreEntries,
    [],
    `Generated-spec accounting has duplicate workspace store entry/entries: ${accounting.duplicateStoreEntries.map((entry) => `${entry.slug} (${entry.entryCount})`).join(', ')}`,
  );
}

function formatAccountingSlugs(entries: readonly { slug: string }[]): string {
  return entries.length === 0 ? 'none' : entries.map((entry) => entry.slug).join(', ');
}

function printGeneratedSpecAccountingCensus(
  t: { diagnostic(message: string): void },
  accounting: GeneratedSpecAccounting,
): void {
  t.diagnostic(
    `Generated-spec accounting census: stamped ${accounting.stamped.length} [${formatAccountingSlugs(accounting.stamped)}]; carved ${accounting.carved.length} [${formatAccountingSlugs(accounting.carved)}]; pending ${accounting.pending.length} [${formatAccountingSlugs(accounting.pending)}]; roster-deferred ${accounting.deferredStampedRoster.length} [${formatAccountingSlugs(accounting.deferredStampedRoster)}].`,
  );
  for (const carveOut of accounting.carved) {
    t.diagnostic(`carve-out honored: ${carveOut.slug} (finished by hand after generation).`);
  }
  for (const pending of accounting.pending) {
    t.diagnostic(`pending parity disposition: ${pending.slug} — ${pending.reason} Surfacing: ${pending.surfacing}.`);
  }
  for (const deferred of accounting.deferredStampedRoster) {
    t.diagnostic(
      `stamped-roster deferred: ${deferred.slug} — this tree has no runtime emitted-hash store, so the stamp cannot be checked here.`,
    );
  }
}

/**
 * Renderer-contract audit: it only inspects a finite marker enum on a spec
 * whose content exactly matches the emitter hash. A hand-edited or unstamped
 * spec is deliberately reported out of scope, not scanned for prose. Entries
 * resolving outside the audited workspace are excluded before their sources
 * are read: test-temp hash entries cannot become live-corpus audit subjects.
 */
function auditEmittedMarkerParity(
  workspaceRoot: string,
  entries: readonly SpecEmittedHashEntry[],
  sources: ReadonlyMap<string, string>,
  sidecars: ReadonlyMap<string, Sidecar>,
): MarkerAudit {
  const audit: MarkerAudit = {
    checked: [],
    excludedOutsideWorkspace: [],
    matchingHashSources: [],
    missing: [],
    outOfParityScope: [],
  };
  for (const entry of entries) {
    if (!isWorkspaceEmittedSpecPath(workspaceRoot, entry.specPath)) {
      audit.excludedOutsideWorkspace.push(entry.specPath);
      continue;
    }
    const source = sources.get(entry.specPath);
    if (source === undefined) {
      audit.outOfParityScope.push({ specPath: entry.specPath, reason: 'spec source unavailable' });
      continue;
    }
    if (hashSpecContent(source) !== entry.specSha256) {
      audit.outOfParityScope.push({ specPath: entry.specPath, reason: 'emitted hash does not match (hand-edited or stale)' });
      continue;
    }
    audit.matchingHashSources.push(entry.specPath);
    const sidecar = sidecars.get(entry.specPath);
    if (sidecar === undefined) {
      audit.outOfParityScope.push({ specPath: entry.specPath, reason: 'matching emitted spec has no readable sidecar' });
      continue;
    }
    audit.checked.push(entry.specPath);
    for (const marker of rendererHonestyMarkers(sidecar)) {
      if (!source.includes(`${SPEC_HONESTY_MARKER_PREFIX}${marker}`)) audit.missing.push({ specPath: entry.specPath, marker });
    }
  }
  return audit;
}

/** A matching emitted source must yield at least one real parity check; otherwise the audit is inert. */
function assertMarkerAuditIsActive(audit: MarkerAudit): void {
  assert.ok(
    audit.matchingHashSources.length === 0 || audit.checked.length > 0,
    `Renderer marker audit inert: ${audit.matchingHashSources.length} workspace emitted spec hash(es) matched but none were parity-checked.`,
  );
}

/**
 * A non-empty `audit.missing` is a real renderer defect: stop and report it;
 * never weaken this floor to make the audit pass.
 */
function assertNoMissingRendererMarkers(audit: MarkerAudit): void {
  assert.deepEqual(audit.missing, [], `Renderer marker audit found missing marker(s): ${JSON.stringify(audit.missing)}.`);
}

/**
 * The coverage floor arms only from live store state. Stage/CI intentionally do not
 * ship this runtime store, so an empty store is dormant rather than a narrative skip.
 */
function assertLiveCoverageFloor(audit: MarkerAudit, workspaceStoreEntryCount: number): 'armed' | 'dormant' {
  if (workspaceStoreEntryCount === 0) return 'dormant';
  assert.ok(
    audit.checked.length >= 1,
    `Renderer marker audit live coverage is 0 despite ${workspaceStoreEntryCount} workspace-resident emitted-hash store entry/entries. Cannot check: ${audit.outOfParityScope.map((entry) => entry.specPath).join(', ')}.`,
  );
  return 'armed';
}

test('renderer honesty markers: finite enum and direct synthetic sidecars cover every marker class plus the no-marker baseline', () => {
  assert.equal(RENDERER_HONESTY_MARKER_CODES.length, 5);
  const markerBase = (): Sidecar => ({ ...sidecar(), steps: [] });
  const cases: Array<{ marker: RendererHonestyMarkerCode; sidecar: Sidecar; planText?: RegExp }> = [
    {
      marker: 'console-clean',
      sidecar: { ...markerBase(), assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] },
      planText: /witnessed-clean/,
    },
    {
      marker: 'console-inferred',
      sidecar: { ...markerBase(), assertions: [{ type: 'no-console-errors', witnessed: 'inferred', enabled: true }] },
      planText: /inferred — no replay recording/,
    },
    {
      marker: 'console-dirty',
      sidecar: { ...markerBase(), assertions: [{ type: 'no-console-errors', witnessed: 'dirty', enabled: false }] },
      planText: /console errors — console is not asserted clean/,
    },
    {
      marker: 'placeholder-value',
      sidecar: sidecar(true),
      planText: /placeholder value/,
    },
    {
      marker: 'missing-navigation-hop',
      sidecar: { ...markerBase(), missingNavigationHops: ['/confirmation'] },
    },
  ];
  assert.equal(cases.length, 5);

  for (const candidate of cases) {
    const spec = renderScaffoldSpec(candidate.sidecar, candidate.marker);
    assert.deepEqual(rendererHonestyMarkers(candidate.sidecar), [candidate.marker]);
    assert.match(spec, new RegExp(`${SPEC_HONESTY_MARKER_PREFIX}${candidate.marker}`));
    if (candidate.planText !== undefined) assert.match(renderPlanMarkdown(candidate.sidecar), candidate.planText);
  }

  const noMarker = markerBase();
  assert.deepEqual(rendererHonestyMarkers(noMarker), []);
  assert.equal(renderScaffoldSpec(noMarker, 'no-marker').includes(SPEC_HONESTY_MARKER_PREFIX), false);
});

test('renderer honesty marker audit: only matching emitted hashes are parity-checked; hash-mismatched specs are separately disclosed', () => {
  const emitted = { ...sidecar(), steps: [], assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] } as Sidecar;
  const emittedPath = 'tests/generated/emitted.spec.ts';
  const emittedSource = renderScaffoldSpec(emitted, 'emitted');
  const changedPath = 'tests/generated/changed.spec.ts';
  const changedSource = renderScaffoldSpec(emitted, 'changed').replace('console-clean', 'removed-marker');
  const entries: SpecEmittedHashEntry[] = [
    { slug: 'emitted', specPath: emittedPath, specSha256: hashSpecContent(emittedSource), generatedAt: '2026-08-18T00:00:00.000Z' },
    { slug: 'changed', specPath: changedPath, specSha256: hashSpecContent(`${changedSource}\noriginal`), generatedAt: '2026-08-18T00:00:00.000Z' },
  ];
  const audit = auditEmittedMarkerParity('/workspace', entries, new Map([[emittedPath, emittedSource], [changedPath, changedSource]]), new Map([[emittedPath, emitted], [changedPath, emitted]]));
  assert.deepEqual(audit.checked, [emittedPath]);
  assert.deepEqual(audit.excludedOutsideWorkspace, []);
  assert.deepEqual(audit.matchingHashSources, [emittedPath]);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.outOfParityScope, [{ specPath: changedPath, reason: 'emitted hash does not match (hand-edited or stale)' }]);
});

test('renderer honesty marker audit: temp-path hash records are excluded structurally before they can be read as workspace specs', () => {
  const emitted = { ...sidecar(), steps: [], assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] } as Sidecar;
  const emittedPath = 'tests/generated/emitted.spec.ts';
  const tempPath = '../../../../var/folders/example/T/replaytest-fixture/tests/generated/temp.spec.ts';
  const emittedSource = renderScaffoldSpec(emitted, 'emitted');
  const tempSource = renderScaffoldSpec(emitted, 'temp');
  const audit = auditEmittedMarkerParity(
    '/workspace',
    [
      { slug: 'emitted', specPath: emittedPath, specSha256: hashSpecContent(emittedSource), generatedAt: '2026-08-18T00:00:00.000Z' },
      { slug: 'temp', specPath: tempPath, specSha256: hashSpecContent(tempSource), generatedAt: '2026-08-18T00:00:00.000Z' },
    ],
    new Map([[emittedPath, emittedSource], [tempPath, tempSource]]),
    new Map([[emittedPath, emitted], [tempPath, emitted]]),
  );
  assert.deepEqual(audit.checked, [emittedPath]);
  assert.deepEqual(audit.matchingHashSources, [emittedPath]);
  assert.deepEqual(audit.excludedOutsideWorkspace, [tempPath]);
  assert.deepEqual(audit.missing, []);
});

test('renderer honesty marker audit: matching workspace hashes with no checked spec fail as an inert audit', () => {
  const emitted = { ...sidecar(), steps: [], assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] } as Sidecar;
  const emittedPath = 'tests/generated/emitted.spec.ts';
  const emittedSource = renderScaffoldSpec(emitted, 'emitted');
  const audit = auditEmittedMarkerParity(
    '/workspace',
    [{ slug: 'emitted', specPath: emittedPath, specSha256: hashSpecContent(emittedSource), generatedAt: '2026-08-18T00:00:00.000Z' }],
    new Map([[emittedPath, emittedSource]]),
    new Map(),
  );
  assert.deepEqual(audit.checked, []);
  assert.deepEqual(audit.matchingHashSources, [emittedPath]);
  assert.throws(
    () => assertMarkerAuditIsActive(audit),
    /Renderer marker audit inert: 1 workspace emitted spec hash\(es\) matched but none were parity-checked\./,
  );
});

test('renderer honesty marker audit: the approved accounting policy pins the exact carve-out and pending populations', () => {
  assert.equal(HAND_FINISHED_CARVE_OUTS.length, 2);
  const ruledEntries = [
      {
        slug: 'invoice-confirmation',
        since: '2026-07-02',
        reason: 'Finished after generation; a machine-write hash cannot attest to hand edits.',
      },
      {
        slug: 'invoices-inv-1003',
        since: '2026-07-02',
        reason: 'Finished after generation; a machine-write hash cannot attest to hand edits.',
      },
    ] as const;
  assert.deepEqual(HAND_FINISHED_CARVE_OUTS, ruledEntries);
  assert.deepEqual(ruledEntries, HAND_FINISHED_CARVE_OUTS);
  // Exact empty pin via length; a deepEqual-vs-[] here would narrow the constant to never[] (TS2339 on the loop below).
  assert.equal(PENDING_PARITY_SPECS.length, 0);
  assert.equal(STAMPED_ROSTER.length, 1);
  assert.deepEqual(STAMPED_ROSTER, ['customer-created']);
  // The three disposition lists are disjoint by construction; overlap is a policy contradiction.
  for (const slug of STAMPED_ROSTER) {
    assert.ok(!HAND_FINISHED_CARVE_OUTS.some((entry) => entry.slug === slug), `roster slug ${slug} also carved`);
    assert.ok(!PENDING_PARITY_SPECS.some((entry) => entry.slug === slug), `roster slug ${slug} also pending`);
  }
});

test('renderer honesty marker audit: a git-archive fresh-checkout parse pins the committed registry content in both directions', () => {
  // Strict mode reads a fresh archive of HEAD, so working-tree changes cannot
  // satisfy the content pin. If the archive has no copy of the expected file,
  // check the working-tree file in both directions until the file is committed.
  let freshCheckoutRaw: string;
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD', '--', '.replaytest/hand-finished.json'], { cwd: repoRoot });
    freshCheckoutRaw = execFileSync('tar', ['-xOf', '-', '.replaytest/hand-finished.json'], { cwd: repoRoot, input: archive }).toString('utf8');
  } catch {
    const inHead = spawnSync('git', ['cat-file', '-e', 'HEAD:.replaytest/hand-finished.json'], { cwd: repoRoot });
    assert.equal(inHead.status === 0, false, 'git archive failed although the registry IS in HEAD — investigate, do not fall back');
    freshCheckoutRaw = fs.readFileSync(path.join(repoRoot, '.replaytest/hand-finished.json'), 'utf8');
  }
  const freshCheckoutParse = parseHandFinishedRegistry(freshCheckoutRaw);
  assert.equal('error' in freshCheckoutParse, false);
  if ('error' in freshCheckoutParse) return;
  assert.deepEqual(freshCheckoutParse.entries, HAND_FINISHED_CARVE_OUTS);
  assert.deepEqual(HAND_FINISHED_CARVE_OUTS, freshCheckoutParse.entries);
});

test('renderer honesty marker audit mutation proof: a stamped spec whose renderer marker was dropped goes RED', () => {
  const emitted = { ...sidecar(), steps: [], assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] } as Sidecar;
  const emittedPath = 'tests/generated/emitted.spec.ts';
  const droppedMarkerSource = renderScaffoldSpec(emitted, 'emitted').replace(
    `${SPEC_HONESTY_MARKER_PREFIX}console-clean`,
    'removed-marker',
  );
  const audit = auditEmittedMarkerParity(
    '/workspace',
    [{ slug: 'emitted', specPath: emittedPath, specSha256: hashSpecContent(droppedMarkerSource), generatedAt: '2026-08-19T00:00:00.000Z' }],
    new Map([[emittedPath, droppedMarkerSource]]),
    new Map([[emittedPath, emitted]]),
  );
  assert.deepEqual(audit.missing, [{ specPath: emittedPath, marker: 'console-clean' }]);
  assert.throws(
    () => assertNoMissingRendererMarkers(audit),
    /Renderer marker audit found missing marker\(s\): \[{"specPath":"tests\/generated\/emitted\.spec\.ts","marker":"console-clean"}\]\./,
  );
});

test('renderer honesty marker audit mutation proof: an unexplained hash-less generated spec goes RED', () => {
  const accounting = accountGeneratedSpecs(
    '/workspace',
    [{ slug: 'unexplained', specPath: 'tests/generated/unexplained.spec.ts' }],
    [],
    false,
    { carveOuts: [], pending: [], stampedRoster: [] },
  );
  assert.deepEqual(accounting.unexplained, [
    {
      slug: 'unexplained',
      specPath: 'tests/generated/unexplained.spec.ts',
      reason: 'no emitter hash, carve-out, or pending disposition',
    },
  ]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(accounting),
    /Generated-spec accounting has unexplained spec\(s\): unexplained \(no emitter hash, carve-out, or pending disposition\)/,
  );
});

test('renderer honesty marker audit mutation proof: a workspace store entry with zero checked specs goes RED', () => {
  const emittedPath = 'tests/generated/emitted.spec.ts';
  const entries: SpecEmittedHashEntry[] = [
    { slug: 'emitted', specPath: emittedPath, specSha256: 'fixture-hash', generatedAt: '2026-08-19T00:00:00.000Z' },
  ];
  const accounting = accountGeneratedSpecs('/workspace', [{ slug: 'emitted', specPath: emittedPath }], entries, true, { carveOuts: [], pending: [], stampedRoster: ['emitted'] });
  const audit = auditEmittedMarkerParity('/workspace', entries, new Map(), new Map());
  assert.equal(accounting.workspaceStoreEntries.length, 1);
  assert.deepEqual(audit.checked, []);
  assert.deepEqual(audit.outOfParityScope, [{ specPath: emittedPath, reason: 'spec source unavailable' }]);
  assert.throws(
    () => assertLiveCoverageFloor(audit, accounting.workspaceStoreEntries.length),
    /Renderer marker audit live coverage is 0 despite 1 workspace-resident emitted-hash store entry\/entries\. Cannot check: tests\/generated\/emitted\.spec\.ts\./,
  );
});

test('renderer honesty marker audit mutation proof: obsolete carve-out and pending policy rows go RED', () => {
  const stampedSpec = { slug: 'still-present', specPath: 'tests/generated/still-present.spec.ts' };
  const entries: SpecEmittedHashEntry[] = [
    { slug: stampedSpec.slug, specPath: stampedSpec.specPath, specSha256: 'fixture-hash', generatedAt: '2026-08-19T00:00:00.000Z' },
  ];
  const cases: Array<{ policy: SpecAccountingPolicy; expected: RegExp }> = [
    {
      policy: {
        carveOuts: [{ slug: 'obsolete-carve-out', since: '2026-07-02', reason: 'Fixture-only obsolete carve-out for a spec finished by hand.' }],
        pending: [],
        stampedRoster: ['still-present'],
      },
      expected: /Generated-spec accounting has obsolete hand-finished carve-out\(s\): obsolete-carve-out/,
    },
    {
      policy: {
        carveOuts: [],
        pending: [{ slug: 'obsolete-pending', since: '2026-08-19', reason: 'Fixture-only obsolete pending disposition.', surfacing: 'Disclose obsolete pending entries before retiring them.' }],
        stampedRoster: ['still-present'],
      },
      expected: /Generated-spec accounting has obsolete pending disposition\(s\): obsolete-pending/,
    },
  ];
  for (const candidate of cases) {
    const accounting = accountGeneratedSpecs('/workspace', [stampedSpec], entries, true, candidate.policy);
    assert.throws(() => assertGeneratedSpecStructuralFloor(accounting), candidate.expected);
  }
});

test('renderer honesty marker audit mutation proof: duplicate workspace store entries for one generated spec go RED', () => {
  const spec = { slug: 'duplicated', specPath: 'tests/generated/duplicated.spec.ts' };
  const entries: SpecEmittedHashEntry[] = [
    { slug: spec.slug, specPath: spec.specPath, specSha256: 'first-fixture-hash', generatedAt: '2026-08-19T00:00:00.000Z' },
    { slug: spec.slug, specPath: spec.specPath, specSha256: 'second-fixture-hash', generatedAt: '2026-08-19T00:00:00.000Z' },
  ];
  const accounting = accountGeneratedSpecs('/workspace', [spec], entries, true, { carveOuts: [], pending: [], stampedRoster: [spec.slug] });
  assert.deepEqual(accounting.duplicateStoreEntries, [{ ...spec, entryCount: 2 }]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(accounting),
    /Generated-spec accounting has duplicate workspace store entry\/entries: duplicated \(2\)/,
  );
});

test('stamped-roster on a store-less tree: roster members defer disclosed, and a rogue spec still goes RED', () => {
  const roster = { slug: 'rostered', specPath: 'tests/generated/rostered.spec.ts' };
  const rogue = { slug: 'rogue', specPath: 'tests/generated/rogue.spec.ts' };
  const policy: SpecAccountingPolicy = { carveOuts: [], pending: [], stampedRoster: ['rostered'] };

  const deferredOnly = accountGeneratedSpecs('/workspace', [roster], [], false, policy);
  assert.deepEqual(deferredOnly.deferredStampedRoster, [roster]);
  assert.deepEqual(deferredOnly.unexplained, []);
  assertGeneratedSpecStructuralFloor(deferredOnly);

  const withRogue = accountGeneratedSpecs('/workspace', [roster, rogue], [], false, policy);
  assert.deepEqual(withRogue.deferredStampedRoster, [roster]);
  assert.deepEqual(withRogue.unexplained, [{ ...rogue, reason: 'no emitter hash, carve-out, or pending disposition' }]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(withRogue),
    /Generated-spec accounting has unexplained spec\(s\): rogue \(no emitter hash, carve-out, or pending disposition\)/,
  );
});

test('stamped-roster on a store-bearing tree: an unstamped roster member goes RED (roster-store drift)', () => {
  const roster = { slug: 'rostered', specPath: 'tests/generated/rostered.spec.ts' };
  const other = { slug: 'other', specPath: 'tests/generated/other.spec.ts' };
  const entries: SpecEmittedHashEntry[] = [
    { slug: other.slug, specPath: other.specPath, specSha256: 'fixture-hash', generatedAt: '2026-08-20T00:00:00.000Z' },
  ];
  const accounting = accountGeneratedSpecs('/workspace', [roster, other], entries, true, { carveOuts: [], pending: [], stampedRoster: ['rostered', 'other'] });
  assert.deepEqual(accounting.deferredStampedRoster, []);
  assert.deepEqual(accounting.unexplained, [{ ...roster, reason: 'stamped-roster spec has no workspace store entry on a store-bearing tree' }]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(accounting),
    /Generated-spec accounting has unexplained spec\(s\): rostered \(stamped-roster spec has no workspace store entry on a store-bearing tree\)/,
  );
});

test('stamped-roster discriminator: a store holding ONLY out-of-workspace entries is store-BEARING — roster drift REDs, never defers', () => {
  const roster = { slug: 'rostered', specPath: 'tests/generated/rostered.spec.ts' };
  const foreignOnly: SpecEmittedHashEntry[] = [
    { slug: 'temp', specPath: '../../../../var/folders/example/T/replaytest-fixture/tests/generated/temp.spec.ts', specSha256: 'fixture-hash', generatedAt: '2026-08-20T00:00:00.000Z' },
  ];
  const accounting = accountGeneratedSpecs('/workspace', [roster], foreignOnly, true, { carveOuts: [], pending: [], stampedRoster: ['rostered'] });
  assert.equal(accounting.workspaceStoreEntries.length, 0);
  assert.deepEqual(accounting.deferredStampedRoster, []);
  assert.deepEqual(accounting.unexplained, [{ ...roster, reason: 'stamped-roster spec has no workspace store entry on a store-bearing tree' }]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(accounting),
    /Generated-spec accounting has unexplained spec\(s\): rostered \(stamped-roster spec has no workspace store entry on a store-bearing tree\)/,
  );
});

test('stamped-roster completeness: a store-stamped spec missing from the roster goes RED', () => {
  const spec = { slug: 'freshly-stamped', specPath: 'tests/generated/freshly-stamped.spec.ts' };
  const entries: SpecEmittedHashEntry[] = [
    { slug: spec.slug, specPath: spec.specPath, specSha256: 'fixture-hash', generatedAt: '2026-08-20T00:00:00.000Z' },
  ];
  const accounting = accountGeneratedSpecs('/workspace', [spec], entries, true, { carveOuts: [], pending: [], stampedRoster: [] });
  assert.deepEqual(accounting.unrosteredStamped, [spec]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(accounting),
    /Generated-spec accounting has store-stamped spec\(s\) missing from the tracked stamped roster: freshly-stamped/,
  );
});

test('stamped-roster hygiene: obsolete roster slugs and roster+carve-out contradictions go RED', () => {
  const present = { slug: 'present', specPath: 'tests/generated/present.spec.ts' };
  const obsolete = accountGeneratedSpecs('/workspace', [present], [], false, { carveOuts: [], pending: [], stampedRoster: ['present', 'gone-spec'] });
  assert.deepEqual(obsolete.obsoleteStampedRoster, ['gone-spec']);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(obsolete),
    /Generated-spec accounting has obsolete stamped-roster slug\(s\): gone-spec/,
  );

  const conflicted = accountGeneratedSpecs('/workspace', [present], [], false, {
    carveOuts: [{ slug: 'present', since: '2026-08-20', reason: 'Fixture-only conflicting carve-out.' }],
    pending: [],
    stampedRoster: ['present'],
  });
  assert.deepEqual(conflicted.unexplained, [{ ...present, reason: 'multiple dispositions' }]);
  assert.throws(
    () => assertGeneratedSpecStructuralFloor(conflicted),
    /Generated-spec accounting has unexplained spec\(s\): present \(multiple dispositions\)/,
  );
});

test('renderer honesty marker audit: reports the live matching-hash scope and every withheld hand-edited/stale spec', (t) => {
  const record = readSpecEmittedHashes(specEmittedHashesPath(repoRoot));
  const entries = record?.entries ?? [];
  const specs = walkWorkspaceGeneratedSpecs(repoRoot);
  // Store-FILE presence (not parse success): a present-but-corrupt/schema-drifted store
  // must stay store-BEARING so roster drift REDs instead of deferring with a false
  // "carries no store" disclosure.
  const accounting = accountGeneratedSpecs(repoRoot, specs, entries, fs.existsSync(specEmittedHashesPath(repoRoot)));
  // Census prints BEFORE the floor asserts so a RED run still shows its accounting context.
  printGeneratedSpecAccountingCensus(t, accounting);
  assertGeneratedSpecStructuralFloor(accounting);

  const workspaceEntries = accounting.workspaceStoreEntries;
  const sources = new Map<string, string>();
  const sidecars = new Map<string, Sidecar>();
  for (const entry of workspaceEntries) {
    const specPath = path.join(repoRoot, entry.specPath);
    const sidecarPath = path.join(repoRoot, '.replaytest', 'plans', `${entry.slug}.plan.json`);
    try {
      sources.set(entry.specPath, fs.readFileSync(specPath, 'utf8'));
      sidecars.set(entry.specPath, JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Sidecar);
    } catch {
      // The audit function reports the unavailable input explicitly below.
    }
  }
  const audit = auditEmittedMarkerParity(repoRoot, entries, sources, sidecars);
  // Diagnostics print BEFORE the marker asserts so a RED run still names its context
  // (mirror of the census-before-floor ordering above).
  if (audit.excludedOutsideWorkspace.length > 0) {
    t.diagnostic(`Excluded ${audit.excludedOutsideWorkspace.length} emitted-hash record(s) resolving outside this workspace.`);
  }
  for (const withheld of audit.outOfParityScope) {
    t.diagnostic(`Out of parity scope: ${withheld.specPath} — ${withheld.reason}. Next option: establish a new baseline only through an approved replaytest write path.`);
  }
  if (audit.matchingHashSources.length === 0) {
    t.diagnostic('No workspace emitted spec with a matching hash was available for renderer parity checking.');
  }
  assertNoMissingRendererMarkers(audit);
  assertMarkerAuditIsActive(audit);
  const coverageState = assertLiveCoverageFloor(audit, accounting.workspaceStoreEntries.length);
  if (coverageState === 'dormant') {
    t.diagnostic('LIVE COVERAGE 0 — no workspace-resident emitted-hash store entries on this tree; expected on stage/CI checkouts, where the runtime store never ships.');
  }
  t.diagnostic(`Emitted-hash-scoped renderer parity checked ${audit.checked.length} spec(s); withheld ${audit.outOfParityScope.length}.`);
});
