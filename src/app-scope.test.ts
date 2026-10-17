import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  appScopeCacheFileSuffix,
  appScopeDisclosure,
  displayOrigin,
  matchesAppUrlPrefix,
  parseAppScopeConfig,
  resolveAppScope,
  scopeSessionsByWitnessedUrls,
} from './app-scope.js';
import { isTransientProbePath, readSourceFile, withSourceSnapshotRetry } from './test-discovery.js';

test('app scope boundary matching rejects host and path-prefix spoofs', () => {
  assert.equal(matchesAppUrlPrefix('https://myshop.com/orders/42', 'https://myshop.com'), true);
  assert.equal(matchesAppUrlPrefix('https://myshop.com?campaign=spring', 'https://myshop.com'), true);
  assert.equal(matchesAppUrlPrefix('https://myshop.com.evil.example/orders', 'https://myshop.com'), false);
  assert.equal(matchesAppUrlPrefix('https://myshop.com/app/orders', 'https://myshop.com/app'), true);
  assert.equal(matchesAppUrlPrefix('https://myshop.com/app?tab=orders', 'https://myshop.com/app'), true);
  assert.equal(matchesAppUrlPrefix('https://myshop.com/app2/orders', 'https://myshop.com/app'), false);
});

test('app config selects its default and --app-style override takes precedence', () => {
  const parsed = parseAppScopeConfig(JSON.stringify({
    apps: {
      storefront: ['https://shop.example', 'https://staging.shop.example/app/'],
      admin: ['https://admin.example'],
    },
    app: 'storefront',
  }));
  assert.ok(!('error' in parsed));
  if ('error' in parsed) return;

  assert.deepEqual(resolveAppScope(parsed, undefined), {
    app: 'storefront',
    prefixes: ['https://shop.example', 'https://staging.shop.example/app'],
  });
  assert.deepEqual(resolveAppScope(parsed, 'admin'), {
    app: 'admin',
    prefixes: ['https://admin.example'],
  });
  assert.deepEqual(resolveAppScope(parsed, 'missing'), {
    error: '--app missing does not name an app declared in .replaytest/config.json.',
  });
});

test('raw session scope keeps app matches, discloses unattributable sessions, and nudges only unscoped mixed origins', () => {
  const sessions = [
    { id: 'shop', urls: ['https://shop.example/orders'] },
    { id: 'admin', urls: ['https://admin.example/users'] },
    { id: 'unknown', urls: [] },
  ];
  const scope = { app: 'shop', prefixes: ['https://shop.example'] };
  const scoped = scopeSessionsByWitnessedUrls(sessions, (session) => session.urls, scope);
  assert.deepEqual(scoped.sessions.map((session) => session.id), ['shop']);
  assert.equal(scoped.unattributableSessions, 1);
  assert.equal(scoped.excludedSessions, 1);
  assert.deepEqual(appScopeDisclosure(scoped, scope), {
    scope,
    unattributableSessions: 1,
    excludedSessions: 1,
  });

  const oneOrigin = scopeSessionsByWitnessedUrls([sessions[0]!], (session) => session.urls, undefined);
  assert.equal(appScopeDisclosure(oneOrigin, undefined), undefined);
  const mixedOrigins = scopeSessionsByWitnessedUrls(sessions.slice(0, 2), (session) => session.urls, undefined);
  assert.deepEqual(appScopeDisclosure(mixedOrigins, undefined), {
    origins: ['https://admin.example', 'https://shop.example'],
  });
});

test('cache-file identity keeps the unscoped name, separates every distinct boundary, and stays filesystem-safe', () => {
  assert.equal(appScopeCacheFileSuffix(undefined), '', 'an unscoped run must keep the exact filename it always had');

  const shop = appScopeCacheFileSuffix({ app: 'shop', prefixes: ['https://shop.example'] });
  assert.match(shop, /^\.app-[0-9a-f]{16}$/);
  assert.equal(appScopeCacheFileSuffix({ app: 'shop', prefixes: ['https://shop.example'] }), shop, 'the same boundary is the same cache');
  assert.notEqual(appScopeCacheFileSuffix({ app: 'admin', prefixes: ['https://shop.example'] }), shop, 'a different app is a different cache');
  assert.notEqual(
    appScopeCacheFileSuffix({ app: 'shop', prefixes: ['https://shop.example', 'https://staging.shop.example'] }),
    shop,
    're-pointing an app at more URLs is a different cache, never a stale hit',
  );
  assert.equal(
    appScopeCacheFileSuffix({ app: 'shop', prefixes: ['https://b.example', 'https://a.example'] }),
    appScopeCacheFileSuffix({ app: 'shop', prefixes: ['https://a.example', 'https://b.example'] }),
    'declaration order is not part of the boundary',
  );

  // An app name is only required to be non-empty and whitespace-free, so it can
  // legally carry path separators; none of that may reach a filename.
  const hostile = appScopeCacheFileSuffix({ app: '../../etc/passwd', prefixes: ['https://shop.example'] });
  assert.match(hostile, /^\.app-[0-9a-f]{16}$/);
});

interface SourceUnderGuard {
  file: string;
  text: string;
}

const RAW_RANKING_ENTRY_POINTS = new Set([
  'rankCanonicalJourneys',
  'rankCanonicalJourneyFamilies',
  'rankCoarseJourneys',
  'rankCoarseJourneyFamilies',
  'completionCountsForSessions',
  'findFlowVariants',
]);
const DISCOVERY_ENTRY_POINTS = new Set(['rankDiscoveryJourneys', 'rankDiscoveryJourneyFamilies']);
/**
 * The maintenance verbs' scan entry points. Like the discovery entry points
 * they fetch their own raw sessions internally, so the structural obligation on
 * a caller is to HAND DOWN the boundary — a call site that omits `appScope`
 * produces a verdict, a coverage count, or a repair proposal from whatever
 * traffic happens to be in the project.
 */
const MAINTENANCE_SCAN_ENTRY_POINTS = new Set([
  'collectTriageReport',
  'collectHealReport',
  'collectSuiteStatusReport',
]);
const SCOPING_HELPERS = new Set(['scopeNeutralSessions', 'scopeCoarseSessions', 'scopeSessionsByWitnessedUrls']);

function callsNamed(source: ts.SourceFile, names: ReadonlySet<string>): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function aliasesOf(source: ts.SourceFile, names: ReadonlySet<string>): Set<string> {
  const aliases = new Set(names);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined || !ts.isIdentifier(declaration.initializer)) continue;
      if (!aliases.has(declaration.initializer.text) || aliases.has(declaration.name.text)) continue;
      aliases.add(declaration.name.text);
      changed = true;
    }
  }
  return aliases;
}

function nearestBlock(node: ts.Node): ts.Block | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isBlock(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function scopedBindingAt(source: ts.SourceFile, call: ts.CallExpression, name: string): boolean {
  const candidates: Array<{ declaration: ts.VariableDeclaration; block: ts.Block }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const block = nearestBlock(node);
      if (block !== undefined && node.getStart(source) < call.getStart(source) &&
          block.getStart(source) <= call.getStart(source) && block.getEnd() >= call.getEnd()) {
        candidates.push({ declaration: node, block });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  candidates.sort((left, right) => (left.block.getEnd() - left.block.getStart(source)) - (right.block.getEnd() - right.block.getStart(source)));
  const declaration = candidates[0]?.declaration;
  const initializer = declaration?.initializer;
  return initializer !== undefined && ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) && SCOPING_HELPERS.has(initializer.expression.text);
}

function receivesScopedSessions(source: ts.SourceFile, call: ts.CallExpression): boolean {
  const argument = call.arguments[0];
  return argument !== undefined && ts.isPropertyAccessExpression(argument) && argument.name.text === 'sessions' &&
    ts.isIdentifier(argument.expression) && scopedBindingAt(source, call, argument.expression.text);
}

function objectHasProperty(call: ts.CallExpression, name: string): boolean {
  const first = call.arguments[0];
  return first !== undefined && ts.isObjectLiteralExpression(first) && first.properties.some(
    (property) => (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
      && ts.isIdentifier(property.name)
      && property.name.text === name
    ),
  );
}

// live-src enumerator: E5
export function discoveredProductionSources(root: string): SourceUnderGuard[] {
  return withSourceSnapshotRetry(() => discoveredProductionSourcesOnce(root));
}

function discoveredProductionSourcesOnce(root: string): SourceUnderGuard[] {
  // The guard covers non-test TypeScript modules under `src/`; other source roots and extensions are outside this structural surface.
  const sourceRoot = path.join(root, 'src');
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && !isTransientProbePath(entry.name) && candidate.endsWith('.ts') && !candidate.endsWith('.test.ts')) files.push(candidate);
    }
  };
  visit(sourceRoot);
  return files.sort().map((file) => ({
    file: path.relative(root, file),
    text: readSourceFile(file),
  }));
}

function appScopeGuardViolations(sources: readonly SourceUnderGuard[]): string[] {
  const violations: string[] = [];
  let rawCallCount = 0;
  let discoveryCallCount = 0;
  let maintenanceCallCount = 0;

  for (const input of sources) {
    const source = ts.createSourceFile(input.file, input.text, ts.ScriptTarget.Latest, true);
    const rawCalls = callsNamed(source, aliasesOf(source, RAW_RANKING_ENTRY_POINTS));
    rawCallCount += rawCalls.length;
    for (const call of rawCalls) {
      if (!receivesScopedSessions(source, call)) {
        violations.push(`${input.file}: ${call.expression.getText(source)} expected scoped.sessions from the app-scope chokepoint`);
      }
    }

    const discoveryCalls = callsNamed(source, aliasesOf(source, DISCOVERY_ENTRY_POINTS));
    discoveryCallCount += discoveryCalls.length;
    for (const call of discoveryCalls) {
      if (!objectHasProperty(call, 'appScope')) {
        violations.push(`${input.file}: ${call.expression.getText(source)} must pass appScope to the raw-array chokepoint`);
      }
    }

    const maintenanceCalls = callsNamed(source, aliasesOf(source, MAINTENANCE_SCAN_ENTRY_POINTS));
    maintenanceCallCount += maintenanceCalls.length;
    for (const call of maintenanceCalls) {
      if (!objectHasProperty(call, 'appScope')) {
        violations.push(`${input.file}: ${call.expression.getText(source)} must pass appScope to the maintenance scan`);
      }
    }
  }

  if (rawCallCount === 0) violations.push('no raw-array ranking calls were found');
  if (discoveryCallCount === 0) violations.push('no discovery-ranking calls were found');
  if (maintenanceCallCount === 0) violations.push('no maintenance-scan calls were found');
  return violations;
}

function replaceSource(sources: readonly SourceUnderGuard[], file: string, text: string): SourceUnderGuard[] {
  return sources.map((source) => source.file === file ? { ...source, text } : source);
}

test('ranking entry points remain structurally pinned behind discovered raw-array app scoping', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(appScopeGuardViolations(discoveredProductionSources(root)), []);
});

test('ranking guard catches all commissioned bypass mutations, including aliases and invalid scoped bindings', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sources = discoveredProductionSources(root);
  const selection = sources.find((source) => source.file === 'src/selection.ts')?.text;
  const cli = sources.find((source) => source.file === 'src/cli.ts')?.text;
  const triageVerb = sources.find((source) => source.file === 'src/cli/verbs/triage.ts')?.text;
  const healVerb = sources.find((source) => source.file === 'src/cli/verbs/heal.ts')?.text;
  const suiteStatusVerb = sources.find((source) => source.file === 'src/cli/verbs/suite-status.ts')?.text;
  const suiteHealthVerb = sources.find((source) => source.file === 'src/cli/verbs/suite-health.ts')?.text;
  const triageCore = sources.find((source) => source.file === 'src/triage.ts')?.text;
  assert.ok(selection !== undefined);
  assert.ok(cli !== undefined);
  assert.ok(triageVerb !== undefined);
  assert.ok(healVerb !== undefined);
  assert.ok(suiteStatusVerb !== undefined);
  assert.ok(suiteHealthVerb !== undefined);
  assert.ok(triageCore !== undefined);

  const append = (text: string) => `${text}\n// mutation probe call site\n`;
  const mutations: Array<{ name: string; sources: SourceUnderGuard[] }> = [
    { name: 'mutation-01', sources: replaceSource(sources, 'src/selection.ts', append(selection) + 'rankCanonicalJourneys(sessions);') },
    { name: 'mutation-02', sources: replaceSource(sources, 'src/selection.ts', append(selection) + 'completionCountsForSessions(sessions);') },
    { name: 'mutation-03', sources: replaceSource(sources, 'src/selection.ts', append(selection) + 'rankCoarseJourneys(sessions);') },
    { name: 'mutation-04', sources: replaceSource(sources, 'src/cli.ts', append(cli) + 'rankCoarseJourneys(read.sessions);') },
    { name: 'mutation-05', sources: replaceSource(sources, 'src/cli.ts', append(cli) + 'rankDiscoveryJourneys({ sinceHours: 1 });') },
    { name: 'mutation-06', sources: replaceSource(sources, 'src/cli.ts', append(cli) + 'rankDiscoveryJourneyFamilies({ sinceHours: 1 });') },
    { name: 'mutation-07', sources: replaceSource(sources, 'src/selection.ts', append(selection) + 'rankCanonicalJourneyFamilies(sessions);') },
    { name: 'mutation-08', sources: replaceSource(sources, 'src/selection.ts', append(selection) + 'rankCoarseJourneyFamilies(sessions);') },
    { name: 'mutation-09', sources: replaceSource(sources, 'src/cli.ts', append(cli) + 'completionCountsForSessions(sessions);') },
    { name: 'mutation-10', sources: replaceSource(sources, 'src/cli.ts', append(cli) + 'rankCanonicalJourneys(sessions);') },
    { name: 'mutation-11', sources: replaceSource(sources, 'src/selection.ts', append(selection) + 'const rank = rankCoarseJourneys; rank(sessions);') },
    {
      name: 'mutation-12',
      sources: replaceSource(
        sources,
        'src/selection.ts',
        selection.replace(
          'const scoped = scopeNeutralSessions(sessions, opts.appScope);',
          'const scoped = { sessions, origins: [], unattributableSessions: 0, excludedSessions: 0 };',
        ),
      ),
    },
    // One bypass per maintenance verb: a scan entry point invoked without the
    // boundary, at the very module that owns that verb's wiring.
    { name: 'mutation-13-triage', sources: replaceSource(sources, 'src/cli/verbs/triage.ts', append(triageVerb) + 'collectTriageReport({ sidecar });') },
    { name: 'mutation-14-heal', sources: replaceSource(sources, 'src/cli/verbs/heal.ts', append(healVerb) + 'collectHealReport({ report, plansDir });') },
    {
      name: 'mutation-15-suite-status',
      sources: replaceSource(sources, 'src/cli/verbs/suite-status.ts', append(suiteStatusVerb) + 'collectSuiteStatusReport({ plansDir, generatedTestsDir });'),
    },
    {
      name: 'mutation-16-suite-health',
      sources: replaceSource(sources, 'src/cli/verbs/suite-health.ts', append(suiteHealthVerb) + 'collectSuiteStatusReport({ plansDir, generatedTestsDir });'),
    },
    // The maintenance chokepoint itself: triage's flow-variant ranking reading
    // the raw fetched array instead of the scoped one.
    {
      name: 'mutation-17-triage-flow-variants-unscoped',
      sources: replaceSource(
        sources,
        'src/triage.ts',
        triageCore.replace(
          'const flowVariants = findFlowVariants(scoped.sessions, signature, paramNames);',
          'const flowVariants = findFlowVariants(rawCoarseSessions, signature, paramNames);',
        ),
      ),
    },
  ];

  assert.equal(mutations.length, 17);
  for (const mutation of mutations) {
    assert.notDeepEqual(appScopeGuardViolations(mutation.sources), [], mutation.name);
  }

  assert.notDeepEqual(appScopeGuardViolations([
    ...sources,
    { file: 'src/future-ranking.ts', text: 'rankCanonicalJourneys(sessions);' },
  ]), [], 'new production modules are guarded too');
});

test('displayOrigin: strips http and https schemes case-insensitively', () => {
  assert.equal(displayOrigin('https://shop.test'), 'shop.test');
  assert.equal(displayOrigin('http://shop.test'), 'shop.test');
  assert.equal(displayOrigin('HTTPS://Caps.test'), 'Caps.test', 'uppercase scheme is stripped (case-insensitive)');
  assert.equal(displayOrigin('Http://Mixed.test'), 'Mixed.test', 'mixed-case scheme is stripped');
  assert.equal(displayOrigin('shop.test'), 'shop.test', 'no scheme is a no-op');
  assert.equal(displayOrigin('ws://shop.test'), 'ws://shop.test', 'non-http(s) scheme is retained');
});
