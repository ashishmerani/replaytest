/**
 * Unit tests for `src/suite-scan.ts` — the PURE regex/string extraction
 * analyzer over a customer's existing Playwright suite (piece B).
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listSuiteScanInputs, READ_PROGRESS_BYTE_CADENCE, READ_PROGRESS_FILE_CADENCE, scanSuiteFile, scanSuiteFiles } from './suite-scan.js';
import { listSuiteScanInputs as listDashboardSuiteScanInputs } from './dashboard/server.js';

test('scanSuiteFile: extracts a literal page.goto pathname into visitedCanonical', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await page.goto('/dashboard');`,
  });
  assert.deepEqual(result.visitedCanonical, ['/dashboard']);
  assert.deepEqual(result.assertedCanonical, []);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: extracts a literal toHaveURL pathname into assertedCanonical', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await expect(page).toHaveURL('/invoices/1001/pay');`,
  });
  assert.deepEqual(result.assertedCanonical, ['/invoices/:id/pay']);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: canonicalizes goto/toHaveURL literals the same way journey signatures are canonicalized', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `
      await page.goto('/invoices/1001/pay');
      await expect(page).toHaveURL('/invoices/1001/confirmation');
    `,
  });
  assert.deepEqual(result.visitedCanonical, ['/invoices/:id/pay']);
  assert.deepEqual(result.assertedCanonical, ['/invoices/:id/confirmation']);
});

test('scanSuiteFile: a full URL literal is reduced to its pathname before canonicalization', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await page.goto('http://localhost:3000/invoices/1001/pay');`,
  });
  assert.deepEqual(result.visitedCanonical, ['/invoices/:id/pay']);
});

test('scanSuiteFile: a relative/malformed literal preserves its raw query and fragment fallback before canonicalization', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/wizard.spec.ts',
    content: `await page.goto('/wizard?step=2#intro');`,
  });

  assert.deepEqual(result.visitedCanonical, ['/wizard?step=2#intro']);
});

test('scanSuiteFile: stepped goto and literal toHaveURL canonicalize the step while dropping unrelated query parameters', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/wizard.spec.ts',
    content: `
      await page.goto('/wizard?ref=email&step=2');
      await expect(page).toHaveURL('/wizard/complete?campaign=spring&step=4');
    `,
  });

  assert.deepEqual(result.visitedCanonical, ['/wizard?step=2']);
  assert.deepEqual(result.assertedCanonical, ['/wizard/complete?step=4']);
});

test('scanSuiteFile: an injected override list gives suite coverage the same canonical step token', () => {
  const result = scanSuiteFile(
    {
      filePath: 'tests/existing/phase-wizard.spec.ts',
      content: `await page.goto('/wizard?phase=2');`,
    },
    { wizardStepParamNames: ['step', 'phase'] },
  );
  assert.deepEqual(result.visitedCanonical, ['/wizard?step=2']);
});

test('scanSuiteFile: double-quoted literals are extracted the same as single-quoted', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await page.goto("/dashboard");`,
  });
  assert.deepEqual(result.visitedCanonical, ['/dashboard']);
});

test('scanSuiteFile: a toHaveURL regex literal is kept as an opaque pattern marker, not canonicalized', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await expect(page).toHaveURL(/\\/invoices\\/\\d+\\/pay/);`,
  });
  assert.deepEqual(result.assertedPatterns, ['\\/invoices\\/\\d+\\/pay']);
  assert.deepEqual(result.assertedCanonical, []);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: an origin-prefixed toHaveURL regex with [^/] extracts completely', () => {
  const pattern = String.raw`^(?:[^/]+:\/\/[^/]+)?\/invoices\/[^/]+\/pay$`;
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await expect(page).toHaveURL(/${pattern}/);`,
  });

  assert.deepEqual(result.assertedPatterns, [pattern]);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: an escaped-slash legacy regex literal round-trips unchanged', () => {
  const pattern = String.raw`\/invoices\/\d+\/pay`;
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await expect(page).toHaveURL(/${pattern}/);`,
  });

  assert.deepEqual(result.assertedPatterns, [pattern]);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: an escaped ] inside a regex character class does not end the class', () => {
  const pattern = String.raw`[^\]]+\/orders`;
  const result = scanSuiteFile({
    filePath: 'tests/existing/orders.spec.ts',
    content: `await expect(page).toHaveURL(/${pattern}/);`,
  });

  assert.deepEqual(result.assertedPatterns, [pattern]);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: trailing [^\\/]+ keeps its lenient hash-fragment absorption', () => {
  const pattern = String.raw`^(?:[^/]+:\/\/[^/]+)?\/invoices\/[^\/]+$`;
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await expect(page).toHaveURL(/${pattern}/);`,
  });

  assert.deepEqual(result.assertedPatterns, [pattern]);
  // Intentional current behavior: the final dynamic segment excludes only
  // `/`, so it also absorbs a trailing hash fragment.
  assert.ok(new RegExp(pattern).test('https://example.test/invoices/inv-1003#receipt'));
});

test('scanSuiteFile: a dynamic/templated page.goto argument counts as unparsed, not silently dropped', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `
      const base = getBaseUrl();
      await page.goto(base + '/dashboard');
      await page.goto(\`\${base}/settings\`);
      await page.goto(dynamicPath);
    `,
  });
  assert.deepEqual(result.visitedCanonical, []);
  assert.equal(result.unparsedCount, 3);
});

test('scanSuiteFile: a dynamic toHaveURL argument counts as unparsed', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/invoice.spec.ts',
    content: `await expect(page).toHaveURL(expectedUrl);`,
  });
  assert.deepEqual(result.assertedCanonical, []);
  assert.deepEqual(result.assertedPatterns, []);
  assert.equal(result.unparsedCount, 1);
});

test('scanSuiteFile: multiple goto/toHaveURL calls across a file are all collected, in order', () => {
  const result = scanSuiteFile({
    filePath: 'tests/existing/journey.spec.ts',
    content: `
      test('pays an invoice', async ({ page }) => {
        await page.goto('/dashboard');
        await page.getByRole('link', { name: 'Invoices' }).click();
        await page.goto('/invoices/1001');
        await page.getByRole('button', { name: 'Pay' }).click();
        await expect(page).toHaveURL('/invoices/1001/confirmation');
      });
    `,
  });
  assert.deepEqual(result.visitedCanonical, ['/dashboard', '/invoices/:id']);
  assert.deepEqual(result.assertedCanonical, ['/invoices/:id/confirmation']);
  assert.equal(result.unparsedCount, 0);
});

test('scanSuiteFile: an empty file yields an all-empty, zero-unparsed shape', () => {
  const result = scanSuiteFile({ filePath: 'tests/existing/empty.spec.ts', content: '' });
  assert.deepEqual(result, {
    file: 'tests/existing/empty.spec.ts',
    visitedCanonical: [],
    assertedCanonical: [],
    assertedPatterns: [],
    unparsedCount: 0,
  });
});

test('scanSuiteFile: the result carries the input filePath through as `file`, unmodified', () => {
  const result = scanSuiteFile({ filePath: 'tests/nested/dir/spec.spec.ts', content: '' });
  assert.equal(result.file, 'tests/nested/dir/spec.spec.ts');
});

test('scanSuiteFiles: maps scanSuiteFile over every input file, preserving order', () => {
  const results = scanSuiteFiles([
    { filePath: 'a.spec.ts', content: `await page.goto('/a');` },
    { filePath: 'b.spec.ts', content: `await page.goto('/b');` },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].file, 'a.spec.ts');
  assert.deepEqual(results[0].visitedCanonical, ['/a']);
  assert.equal(results[1].file, 'b.spec.ts');
  assert.deepEqual(results[1].visitedCanonical, ['/b']);
});

test('scanSuiteFiles: an empty input list returns an empty result list', () => {
  assert.deepEqual(scanSuiteFiles([]), []);
});

test('listSuiteScanInputs: directory budget bounds a deep spec-free tree and reports directory-walk progress', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-directory-bound-'));
  try {
    let directory = root;
    for (let index = 0; index < 30; index += 1) {
      directory = path.join(directory, `nested-${index}`);
      fs.mkdirSync(directory);
    }
    // A common vendored subtree must not consume the directory budget at all.
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'node_modules', 'ignored-deep'));

    const progress: string[] = [];
    const result = listSuiteScanInputs({ root, maxDirectories: 26, progress: (line) => progress.push(line) });

    assert.deepEqual(result.inputs, []);
    assert.equal(result.capped, true);
    assert.equal(result.cappedBy, 'maxDirectories');
    assert.equal(result.skippedStandardDirs, true);
    assert.deepEqual(progress, ['Suite scan: 25 directories visited (0 spec file(s) found so far).']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSuiteScanInputs: CLI and dashboard walkers return the same directory-capped enumeration', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-walker-parity-'));
  try {
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, `${name}.spec.ts`), '');
    }
    const opts = { root, workspaceRoot: root, maxFiles: 500, maxDirectories: 3 };
    const cli = listSuiteScanInputs(opts);
    const dashboard = listDashboardSuiteScanInputs(opts);
    const summary = (result: typeof cli) => ({
      files: result.inputs.length,
      capped: result.capped,
      cappedBy: result.cappedBy ?? null,
    });

    assert.deepEqual(summary(cli), { files: 1, capped: true, cappedBy: 'maxDirectories' });
    assert.deepEqual(summary(dashboard), summary(cli));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSuiteScanInputs: exactly reaching the file budget retains the historical capped boundary', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-exact-file-cap-'));
  try {
    fs.writeFileSync(path.join(root, 'a.spec.ts'), '');
    fs.writeFileSync(path.join(root, 'b.spec.ts'), '');

    const result = listSuiteScanInputs({ root, maxFiles: 2 });

    assert.equal(result.inputs.length, 2);
    assert.equal(result.capped, true);
    assert.equal(result.cappedBy, 'maxFiles');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSuiteScanInputs: an oversized spec is disclosed as unreadable instead of silently treated as scanned', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-oversized-file-'));
  try {
    fs.writeFileSync(path.join(root, 'large.spec.ts'), '12345');
    fs.writeFileSync(path.join(root, 'small.spec.ts'), '');

    const result = listSuiteScanInputs({ root, maxFileBytes: 4 });

    assert.deepEqual(result.inputs.map((input) => path.basename(input.filePath)), ['small.spec.ts']);
    assert.equal(result.unreadableFiles, 1);
    assert.equal(result.capped, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSuiteScanInputs: standard directory exclusions are disclosed instead of reading as unqualified completeness', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-standard-exclusions-'));
  try {
    fs.mkdirSync(path.join(root, '.internal'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, '.internal', 'hidden.spec.ts'), '');
    fs.writeFileSync(path.join(root, 'node_modules', 'vendor.spec.ts'), '');
    fs.writeFileSync(path.join(root, 'visible.spec.ts'), '');

    const result = listSuiteScanInputs({ root });

    assert.deepEqual(result.inputs.map((input) => path.basename(input.filePath)), ['visible.spec.ts']);
    assert.equal(result.capped, false);
    assert.equal(result.skippedStandardDirs, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSuiteScanInputs: read progress has a pre-line and exact reset-both file cadence in both enumerators', (t: TestContext) => {
  assert.equal(READ_PROGRESS_FILE_CADENCE, 50);
  assert.equal(READ_PROGRESS_BYTE_CADENCE, 16 * 1024 * 1024);
  const smallRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-read-small-'));
  fs.writeFileSync(path.join(smallRoot, 'small.spec.ts'), 'x', 'utf8');
  const smallProgress: string[] = [];
  listSuiteScanInputs({ root: smallRoot, workspaceRoot: smallRoot, progress: (line) => smallProgress.push(line) });
  assert.deepEqual(smallProgress, ['Suite scan: reading 1 bounded spec files…'], 'a small fixture gets the pre-line only');

  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-read-cadence-'));
  for (let index = 0; index < 100; index += 1) {
    fs.writeFileSync(path.join(root, `small-${String(index).padStart(3, '0')}.spec.ts`), 'x', 'utf8');
  }
  const cliProgress: string[] = [];
  const dashboardProgress: string[] = [];
  listSuiteScanInputs({ root, workspaceRoot: root, progress: (line) => cliProgress.push(line) });
  listDashboardSuiteScanInputs({ root, workspaceRoot: root, progress: (line) => dashboardProgress.push(line) });
  for (const [label, progress] of [['CLI', cliProgress], ['dashboard', dashboardProgress]] as const) {
    assert.equal(progress.length, 1 + Math.floor(100 / READ_PROGRESS_FILE_CADENCE), `${label} must emit the pre-line plus exact file cadence, not per-file noise`);
    assert.match(progress[0] ?? '', /^Suite scan: reading 100 bounded spec files…$/);
    assert.match(progress[1] ?? '', /read 50 of 100 bounded spec files/);
    assert.match(progress[2] ?? '', /read 100 of 100 bounded spec files/);
  }
});

test('listSuiteScanInputs: byte-first progress at the 512 KiB cap emits at file 32 and 16 total lines under reset-both', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-byte-cadence-'));
  const sparseCapSize = 512 * 1024;
  for (let index = 0; index < 500; index += 1) {
    const file = path.join(root, `cap-${String(index).padStart(3, '0')}.spec.ts`);
    fs.writeFileSync(file, 'x', 'utf8');
    fs.truncateSync(file, sparseCapSize);
  }
  const progress: string[] = [];
  listSuiteScanInputs({ root, workspaceRoot: root, progress: (line) => progress.push(line) });
  assert.equal(progress.length, 16, '500 cap-sized files emit one pre-line plus 15 byte/file cadence lines after reset-both');
  assert.match(progress[1] ?? '', /read 32 of 500 bounded spec files/);
});
