import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/artifacts');

export type ArtifactFixtureName = 'default' | 'empty' | 'failures' | 'test-detail-failure' | 'single' | 'scale';

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8')) as T;
}

export const artifactFixture = {
  plans: () => readFixture<{ plans: Array<Record<string, unknown>> }>('plans.json'),
  tests: () => readFixture<{ tests: Array<Record<string, unknown>> }>('tests.json'),
  retired: () => readFixture<Record<string, unknown>>('retired.json'),
  empty: () => readFixture<{ plans: Record<string, unknown>; tests: Record<string, unknown>; retired: Record<string, unknown> }>('empty.json'),
  failures: () => readFixture<{ plans: Record<string, unknown>; tests: Record<string, unknown>; testDetailList: Record<string, unknown>; retired: Record<string, unknown>; testDetail: Record<string, unknown> }>('failures.json'),
  scale: () => readFixture<{ plans: { count: number; slugPrefix: string; lifecycle: string }; tests: { count: number; slugPrefix: string; lifecycle: string } }>('scale-400.json'),
};

function singleArtifactFixture(): { plans: { plans: Array<Record<string, unknown>> }; tests: { tests: Array<Record<string, unknown>> }; retired: Record<string, unknown> } {
  const retired = artifactFixture.retired() as { entries: Array<Record<string, unknown>> };
  // One of everything, inside the row as well as in the count line: the record keeps a single
  // moved artifact, so the singular noun is exercised where a row draws it too.
  const entries = retired.entries.slice(0, 1).map((entry) => (Array.isArray(entry.artifactManifest)
    ? { ...entry, artifactManifest: entry.artifactManifest.slice(0, 1) }
    : entry));
  return {
    plans: { plans: artifactFixture.plans().plans.slice(0, 1) },
    tests: { tests: artifactFixture.tests().tests.slice(0, 1) },
    retired: { ...retired, entries },
  };
}

function scalePlans(): { plans: Array<Record<string, unknown>> } {
  const scale = artifactFixture.scale().plans;
  return {
    plans: Array.from({ length: scale.count }, (_, index) => ({
      kind: 'readable', slug: `${scale.slugPrefix}-${index + 1}`, tested: false, lifecycle: scale.lifecycle,
      sidecar: { title: `Scale plan ${index + 1}`, start: `/scale/${index + 1}`, source: { distinctId: 'fixture', sessionId: 'fixture', journeyIndex: index, generatedAt: '2026-09-20T12:00:00.000Z', tool: 'replaytest' }, steps: [], assertions: [] },
    })),
  };
}

function scaleTests(): { tests: Array<Record<string, unknown>> } {
  const scale = artifactFixture.scale().tests;
  return {
    tests: Array.from({ length: scale.count }, (_, index) => ({
      name: `${scale.slugPrefix}-${index + 1}.spec.ts`, slug: `${scale.slugPrefix}-${index + 1}`,
      kind: 'readable', planned: true, lifecycle: scale.lifecycle,
    })),
  };
}

/** Installs exact server-response envelopes at the dashboard's production HTTP boundary. */
export async function loadArtifactFixture(page: Page, fixture: ArtifactFixtureName = 'default'): Promise<void> {
  const empty = artifactFixture.empty();
  const failures = artifactFixture.failures();
  const single = fixture === 'single' ? singleArtifactFixture() : undefined;
  const plans = fixture === 'scale' ? scalePlans() : fixture === 'single' ? single!.plans : fixture === 'empty' ? empty.plans : fixture === 'failures' ? failures.plans : artifactFixture.plans();
  const tests = fixture === 'scale'
    ? scaleTests()
    : fixture === 'single'
      ? single!.tests
    : fixture === 'empty'
      ? empty.tests
      : fixture === 'failures'
        ? failures.tests
        : fixture === 'test-detail-failure'
          ? failures.testDetailList
          : artifactFixture.tests();
  const retired = fixture === 'single' ? single!.retired : fixture === 'empty' ? empty.retired : fixture === 'failures' ? failures.retired : artifactFixture.retired();
  await page.route('**/api/plans', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(plans) }));
  await page.route('**/api/tests', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(tests) }));
  await page.route('**/api/tests/**', (route) => {
    if (fixture === 'test-detail-failure') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(failures.testDetail) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'planned-checkout.spec.ts', kind: 'readable', content: "test('fixture', () => {});\n" }) });
  });
  await page.route('**/api/retired', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(retired) }));
}

export const ARTIFACTS_PAGE_SIZE = 25;
