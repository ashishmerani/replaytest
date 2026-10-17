import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractSlugHeader } from './generated-spec-headers.js';
import { renderScaffoldSpec } from './sidecar.js';

test('extractSlugHeader: reads the exact literal renderScaffoldSpec emits, as the first line', () => {
  const spec = renderScaffoldSpec({ version: 1, title: 'x', source: { distinctId: 'd', sessionId: 's', journeyIndex: 0, generatedAt: 'now', tool: 't' }, start: '/', steps: [], assertions: [] }, 'invoice-confirmation');
  assert.equal(extractSlugHeader(spec), 'invoice-confirmation');
});

test('extractSlugHeader: absent when there is no header line in the first few lines', () => {
  assert.equal(extractSlugHeader("import { test } from '@playwright/test';\ntest('x', async () => {});\n"), undefined);
});

test('extractSlugHeader: undefined content (unreadable file) -> undefined, never throws', () => {
  assert.equal(extractSlugHeader(undefined), undefined);
});
