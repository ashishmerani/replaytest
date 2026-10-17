import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';

import test from 'node:test';

type PathDisplay = (rows: string[][], words: { oneHidden: string; manyHidden: string; firstRoot: string }) => { prefix: string; labels: Array<string | null> };

const words = { oneHidden: '+1 step', manyHidden: '+[count] steps', firstRoot: 'start page' };
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardAsset = fs.readFileSync(path.join(sourceDirectory, 'index.html'), 'utf8');
const startMarker = '// journey-path-display:start';
const endMarker = '// journey-path-display:end';
const startAt = dashboardAsset.indexOf(startMarker);
const endAt = dashboardAsset.indexOf(endMarker);
assert.ok(startAt >= 0 && endAt > startAt, 'the asset contains an ordered helper extraction region');
const helperBlock = dashboardAsset.slice(startAt + startMarker.length, endAt);
const helperAt = helperBlock.indexOf('function journeyPathDisplay(');
assert.ok(helperAt >= 0, 'the marked block defines journeyPathDisplay');
const helperSource = helperBlock.slice(helperAt).trim();
const journeyPathDisplay = runInNewContext(`(${helperSource})`, {}) as PathDisplay;

function rows(...signatures: string[]): string[][] {
  return signatures.map((signature) => signature.split(/\s*(?:>|→)\s*/).filter(Boolean));
}

function signatureOf(row: string[]): string {
  return row.join(' → ');
}

function display(input: string[][]): ReturnType<PathDisplay> {
  const result = journeyPathDisplay(input, words);
  return { prefix: result.prefix, labels: Array.from(result.labels, (label) => (label === null ? null : String(label))) };
}

test('journey path display implements the written worked examples', () => {
  const cases: Array<{ input: string[][]; prefix: string; labels: Array<string | null> }> = [
    {
      input: rows('/workspace/orders > /workspace/orders/complete', '/workspace/inventory > /workspace/inventory/complete', '/workspace/dispatch > /workspace/dispatch/complete', '/workspace/returns > /workspace/returns/complete'),
      prefix: '/workspace',
      labels: ['orders → complete', 'inventory → complete', 'dispatch → complete', 'returns → complete'],
    },
    {
      input: rows('/ > /invoice.html > /invoice-pay.html > /invoice-confirmation.html', '/ > /customer-new.html > /customer-created.html'),
      prefix: '',
      labels: ['start page → invoice → /invoice-pay → /invoice-confirmation', 'start page → customer-new → /customer-created'],
    },
    { input: rows('/invoices > /invoices/:id > /invoices/:id/pay'), prefix: '', labels: ['invoices → ‹id› → pay'] },
    {
      input: rows('/flows/wizard-8 > /flows/wizard-8/step1 > /flows/wizard-8/step2 > /flows/wizard-8/step3 > /invoices > /invoices/inv-3 > /invoices/inv-3/pay > /flows/promo-3'),
      prefix: '',
      labels: ['flows/wizard-8 → +6 steps → /flows/promo-3'],
    },
    {
      input: rows(
        '/flows/wizard-5 > /flows/wizard-5/step1 > /flows/wizard-5/step2 > /flows/wizard-5/step3 > /flows > /flows/wizard-5/step4 > /flows > /flows/wizard-5/step4',
        '/flows/wizard-5 > /flows/wizard-5/step1 > /flows/wizard-5/step2 > /flows/wizard-5/retry > /flows > /flows/wizard-5/step4 > /flows > /flows/wizard-5/step4',
      ),
      prefix: '',
      labels: [
        'flows/wizard-5 → +2 steps → /flows/wizard-5/step3 → +3 steps → /flows/wizard-5/step4',
        'flows/wizard-5 → +2 steps → /flows/wizard-5/retry → +3 steps → /flows/wizard-5/step4',
      ],
    },
    { input: rows('/a/invoice > /a/done', '/a/invoice.html > /a/done'), prefix: '/a', labels: ['invoice → /done', 'invoice.html → /done'] },
    { input: rows('/x/:id > /x/done', '/x/‹id› > /x/done'), prefix: '/x', labels: [':id → /done', '‹id› → /done'] },
    {
      input: rows('/orders > /orders/complete', '/orders > /complete', '/orders > /orders/orders/complete'),
      prefix: '',
      labels: ['orders → complete', 'orders → /complete', 'orders → orders/complete'],
    },
    { input: rows('/wizard?step=1 > /wizard?step=2'), prefix: '', labels: ['wizard?step=1 → /wizard?step=2'] },
    { input: rows('/workspace/orders'), prefix: '/workspace', labels: ['orders'] },
    { input: rows('/workspace/orders > /workspace/orders', '/workspace/billing > /workspace/billing/complete'), prefix: '/workspace', labels: ['orders → /orders', 'billing → complete'] },
    { input: rows('/checkout > /', '/checkout > / > /help'), prefix: '', labels: ['checkout → /', 'checkout → / → help'] },
    { input: rows('/work/a', '/workspace/b'), prefix: '', labels: ['work/a', 'workspace/b'] },
  ];

  for (const example of cases) assert.deepEqual(display(example.input), { prefix: example.prefix, labels: example.labels });
});

test('a step that is not a sub-page of the step before it keeps its leading slash, whatever the other rows are', () => {
  const input = rows('/orders > /orders/complete', '/orders > /complete', '/orders > /orders/orders/complete');
  const labels = display(input).labels;
  assert.deepEqual(labels, ['orders → complete', 'orders → /complete', 'orders → orders/complete']);
  assert.equal(new Set(labels).size, 3);
  // A label never depends on which other rows exist: the sibling reads the same alone, and so does the sub-page.
  assert.deepEqual(display(rows('/orders > /complete')).labels, ['orders → /complete']);
  assert.deepEqual(display(rows('/orders > /orders/complete')).labels, ['orders → complete']);
  assert.deepEqual(display(rows('/a/invoice > /a/done')).labels, ['invoice → /done']);
  assert.deepEqual(display(rows('/a/invoice > /a/done', '/a/invoice.html > /a/done')).labels, ['invoice → /done', 'invoice.html → /done']);
  // The same page again and a step after a folded gap are not sub-pages either; the first step stays bare.
  assert.deepEqual(display(rows('/orders > /orders')).labels, ['orders → /orders']);
  assert.deepEqual(display(rows('/a > /a/b > /a/b/c > /a/b/c/d > /e')).labels, ['a → +3 steps → /e']);
  // A sub-page that has to be shown in full to break a collision keeps the slash too.
  assert.deepEqual(display(rows('/x/:id > /x/:id/done', '/x/‹id› > /x/‹id›/done')).labels, [':id → /:id/done', '‹id› → /‹id›/done']);
});

test('the shipped 26-row demo corpus has its Short-path golden', () => {
  const demo = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'demo-store.json'), 'utf8')) as {
    sessions: { sessions: Array<{ signature: string }> };
  };
  const areas = [
    'orders', 'inventory', 'dispatch', 'returns', 'reports', 'settings', 'alerts', 'billing', 'customers', 'catalog',
    'shipments', 'locations', 'suppliers', 'carriers', 'invoices', 'refunds', 'warehouses', 'pricing', 'promotions',
    'forecasts', 'audits', 'contracts', 'receiving', 'packing', 'manifests', 'exceptions',
  ];
  const input = demo.sessions.sessions.map((row) => row.signature.split(' > '));
  const result = display(input);
  assert.equal(input.length, 26);
  assert.deepEqual(input.map(signatureOf), areas.map((area) => `/workspace/${area} → /workspace/${area}/complete`));
  assert.equal(result.prefix, '/workspace');
  assert.deepEqual(result.labels, areas.map((area) => `${area} → complete`));
});

test('Short-path labels do not depend on input order', () => {
  const input = rows('/flows/a > /flows/a/step1 > /flows/shared > /done', '/flows/b > /flows/b/step1 > /flows/shared > /done', '/flows/c > /flows/c/step1 > /flows/shared > /done');
  const expected = new Map(input.map((row, index) => [signatureOf(row), display(input).labels[index]]));
  const shuffled = [input[2]!, input[0]!, input[1]!];
  const reordered = display(shuffled);
  assert.equal(reordered.prefix, display(input).prefix);
  assert.deepEqual(new Map(shuffled.map((row, index) => [signatureOf(row), reordered.labels[index]])), expected);
});

test('seeded corpora keep distinct paths distinct and count every hidden step', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const vocabulary = ['a', 'b', 'a.html', ':id', '‹id›', 'c', 'workspace'];
  for (let trial = 0; trial < 250; trial += 1) {
    const signatures = new Set<string>();
    const rowCount = 2 + Math.floor(random() * 12);
    signatures.add('/ > /w/repeat > /w/repeat');
    signatures.add('/w/a.html > /w/a');
    signatures.add('/w/:id?step=1 > /w/‹id›');
    while (signatures.size < rowCount + 3) {
      const stepCount = 1 + Math.floor(random() * 8);
      const steps = Array.from({ length: stepCount }, () => {
        const depth = Math.floor(random() * 3);
        const segments = ['w', ...Array.from({ length: depth }, () => vocabulary[Math.floor(random() * vocabulary.length)]!)];
        const tail = random() < 0.15 ? `?step=${Math.floor(random() * 3)}` : '';
        return `/${segments.join('/')}${tail}`;
      });
      signatures.add(steps.join(' > '));
    }
    const input = rows(...signatures);
    const result = display(input);
    const bySignature = new Map(input.map((row, index) => [signatureOf(row), result.labels[index]]));
    assert.equal(new Set([...bySignature.values()]).size, bySignature.size, `distinct paths stay distinct in seeded trial ${trial}`);
    for (const [index, label] of result.labels.entries()) {
      const row = input[index]!;
      if (row.length === 0 || label === null) continue;
      const lastStep = row[row.length - 1]!;
      const pathPart = lastStep.split(/[?#]/, 1)[0]!;
      const tail = lastStep.slice(pathPart.length);
      const finalSegment = pathPart.split('/').filter(Boolean).at(-1);
      const rawLastLabel = `${finalSegment ?? (row.length > 1 ? '/' : words.firstRoot)}${tail}`;
      const cosmeticLastLabel = `${finalSegment?.replace(/^:id$/, '‹id›').replace(/\.(?:html|htm|php|asp|aspx|jsp)$/i, '') ?? (row.length > 1 ? '/' : words.firstRoot)}${tail}`;
      const lastLabel = label.split(' → ').at(-1) ?? '';
      assert.ok([rawLastLabel, cosmeticLastLabel].some((expected) => lastLabel.endsWith(expected)), `the final step remains visible in seeded trial ${trial}`);
      const components = label.split(' → ');
      const hiddenTokens = components.filter((component) => /^\+\d+ steps?$/.test(component));
      const hiddenTotal = hiddenTokens.reduce((total, component) => total + Number(/\d+/.exec(component)?.[0]), 0);
      assert.equal(hiddenTotal, row.length - (components.length - hiddenTokens.length), `hidden-step counts are exact in seeded trial ${trial}`);
    }
  }
});

test('prefix uses whole segments across all rows, not only a filtered subset', () => {
  const sameArea = Array.from({ length: 25 }, (_, index) => [`/shared/deep/page-${index}`]);
  const otherArea = Array.from({ length: 5 }, (_, index) => [`/shared/wide/page-${index}`]);
  const result = journeyPathDisplay([...sameArea, ...otherArea], words);
  assert.equal(result.prefix, '/shared');
  assert.equal(result.labels[0], 'deep/page-0');
  assert.equal(result.labels[24], 'deep/page-24');
  assert.equal(result.labels[25], 'wide/page-0');
  assert.equal(journeyPathDisplay(rows('/work/a', '/workspace/b'), words).prefix, '');
});

test('empty inputs, single rows, roots, and missing paths have defined results', () => {
  assert.deepEqual(display([]), { prefix: '', labels: [] });
  assert.deepEqual(display([[]]), { prefix: '', labels: [null] });
  assert.deepEqual(display([['/workspace/orders']]), { prefix: '/workspace', labels: ['orders'] });
  assert.deepEqual(display([['/']]), { prefix: '', labels: ['start page'] });
  assert.deepEqual(display(rows('/checkout > /')), { prefix: '', labels: ['checkout → /'] });
  assert.deepEqual(display(rows('/ > /help')), { prefix: '', labels: ['start page → help'] });
});

test('the helper stays under the one-second scale guards', () => {
  const ordinary = Array.from({ length: 20_000 }, (_, index) => Array.from({ length: 12 }, (_, step) => `/app/area-${index % 50}/p${(index * 7 + step) % 97}`));
  const ordinaryStart = performance.now();
  journeyPathDisplay(ordinary, words);
  const ordinaryElapsed = performance.now() - ordinaryStart;
  assert.ok(ordinaryElapsed < 1_000, `20,000 rows × 12 steps took ${Math.round(ordinaryElapsed)}ms`);

  const collisionHeavy = Array.from({ length: 5_000 }, (_, index) => [
    '/app/start',
    ...Array.from({ length: 20 }, (_, step) => `/app/m${step === 10 ? index : step}`),
    '/app/end',
  ]);
  const collisionStart = performance.now();
  const collisionResult = journeyPathDisplay(collisionHeavy, words);
  const collisionElapsed = performance.now() - collisionStart;
  assert.ok(collisionElapsed < 1_000, `5,000 collision-heavy rows × 22 steps took ${Math.round(collisionElapsed)}ms`);
  assert.equal(new Set(collisionResult.labels).size, 5_000);
});
