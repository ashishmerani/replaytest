import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMissingSidecarError, buildMissingPreflightSidecarError, buildScaffoldExistsError, formatFramesTip, formatScaffoldWrittenLines, shouldRefuseScaffoldTarget } from '../../cli.js';

test('buildMissingSidecarError: names the slug and points at plan, never a raw fs error', () => {
  assert.equal(
    buildMissingSidecarError('invoice-confirmation'),
    'No plan found for "invoice-confirmation" — run: replaytest plan <distinctId>.',
  );
  assert.equal(
    buildMissingPreflightSidecarError('invoice-confirmation'),
    'No plan found for "invoice-confirmation" — run: replaytest plan <distinctId>.',
  );
});

test('formatFramesTip: names the local replay command and retention window', () => {
  assert.equal(
    formatFramesTip('invoice-confirmation'),
    'Tip: replaytest frames invoice-confirmation — per-step DOM + screenshots for your coding agent (recordings expire; run it early).',
  );
});

test('formatScaffoldWrittenLines: names both the generated spec and the re-rendered plan', () => {
  assert.deepEqual(formatScaffoldWrittenLines('invoice-confirmation'), [
    'Wrote tests/generated/invoice-confirmation.spec.ts',
    'Wrote .replaytest/plans/invoice-confirmation.md',
  ]);
});

// ---------------------------------------------------------------------------
// Scaffold overwrite guardrail — buildScaffoldExistsError and
// formatScaffoldWrittenLines(--out).
// ---------------------------------------------------------------------------

test('buildScaffoldExistsError: refuses to overwrite, naming the file and both escape hatches', () => {
  const msg = buildScaffoldExistsError('tests/generated/pay-invoice.spec.ts');
  assert.ok(msg.includes('tests/generated/pay-invoice.spec.ts already exists'));
  assert.ok(msg.includes('refusing to overwrite'));
  assert.ok(msg.includes('--force'));
  assert.ok(msg.includes('--out'));
});

test('shouldRefuseScaffoldTarget: default target exists -> refuse unless --force', () => {
  assert.equal(shouldRefuseScaffoldTarget({ force: false }, true), true);
  assert.equal(shouldRefuseScaffoldTarget({ force: true }, true), false);
});

test('shouldRefuseScaffoldTarget: --out fresh path writes, existing --out path refuses, --force overrides', () => {
  assert.equal(shouldRefuseScaffoldTarget({ force: false }, false), false);
  assert.equal(shouldRefuseScaffoldTarget({ force: false }, true), true);
  assert.equal(shouldRefuseScaffoldTarget({ force: true }, true), false);
});

test('formatScaffoldWrittenLines: a --out path is reflected in the confirmation line', () => {
  assert.deepEqual(formatScaffoldWrittenLines('pay-invoice', 'pay-invoice.new.spec.ts'), [
    'Wrote pay-invoice.new.spec.ts',
    'Wrote .replaytest/plans/pay-invoice.md',
  ]);
});
