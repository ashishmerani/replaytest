import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { buildVerbHelpText } from '../help.js';
import { REFUSAL_REGISTRY, coarseStoreLockAdviceClause, namespacedRefusalCode } from '../../refusal-registry.js';
import {
  EXPLAIN_SCHEMA_VERSION,
  EXPLAIN_TEMPLATE_LEGEND,
  explainJsonFixtureEnvelopes,
  hasRoleDependentOutcome,
  runExplain,
} from './explain.js';

/** SHA-256 byte goldens for every resolved `explain --json` output. */
const RESOLVED_JSON_GOLDENS = {
  // The resolved JSON golden set covers every registry row after the content-status collapse.
  'accept.different-journey': '535fc31de6b63f177533a232862b689d17e2a6096d6b2734c363ffd46dd834ae',
  'accept.invalid-hand-finished-registry': '950ff379bdcfe02a2a09fb589285d26891225b3e377ccea0625f7e6ab85dc30d',
  'accept.invalid-live-plan': 'fd67f216ca869a66e9143f61ef99c5f82195d049a7d1f2e19fdfd66f8bb21dd9',
  'accept.invalid-proposal': '77d7850b5bd4ea15405395690619bf1caa5e74e887213033ebae3c1bbef78b5f',
  'accept.live-plan-exists': '06fb097bfaae039cbf4f8e2b34f69d3febe7bec6601c194937af8b580ed52e5c',
  'accept.missing-proposal': 'a779f95e2281f575acb2b87432d96318bbf6bdbb7bd6632baaf4dc194cbbbfe5',
  'accept.retired-no-resurrect': '4d14ba88c462a040b063bc69920138dd12069dd1e474d4bad2c8fd1613c273d7',
  'accept.retirement-recovery-required': '37ab867a53e55cacdf9e4f3a34287ac960a82fe1023ffb63df22c3dd58d27588',
  'accept.state-lock-fenced': '4cb2db66ee74c3c4258ecd207408f10c50b791f1017e1a450aa39876d68885e5',
  'accept.state-lock-held': '2511864a295f3a90cc150999087046b4d8b70779c89d486511a3f46befddef8b',
  'accept.state-lock-released-late': '028d5b8d26836ca56f662c625c1772fdbb1e545c4b07f233e05823acfbaac7d1',
  'auth-setup.privacy-disclosure-required': '7accbd090ff6298bcfb4cc1fd4fdd9a282bea6fc56e1f0c460a40b3d07b9dcc1',
  'doctor.coarse-store-lock-fenced': '663cf768a5e7f6a9cf5f1708aabe8ad27b7c08c0604502f9815f515d686450ae',
  'doctor.coarse-store-lock-held': '7d4926ba170fb3932f91a69fe3cf1e10468ecf9268942859ee862bc19b2c2ed8',
  'doctor.unconfigured': 'cdb63e3525ff1d044b6cfc283aa8a5f222658ac5284b5979c4a73c5f2f5cb56c',
  'explain.ambiguous-code': 'c8edd31949f5b1d7e9f970a8b647ce17c2a602e1600ca23c59a6b44e82f1f182',
  'explain.unknown-code': '820421c255daae89b4a84d90f2c3161fec1775bc1e1470068aed862690a38a29',
  'fix-selector.fix-selector-spec-ambiguous': '1ee556a090c75de379a7989be2d2a7decdc0e5e40d48575fe1aa8fe3849c8000',
  'fix-selector.fix-selector-spec-scan-capped': '4722c198c5e03ecfa42dd5a6d411182f0a062ca9dce208e2dc83df1d07c7d18a',
  'fix-selector.invalid-hand-finished-registry': 'f26fadbe482f4303901ee9f05f10a78fc83c846fa78124029a3243bccafa4f42',
  'fix-selector.privacy-disclosure-required': 'a9a10396845efb7ea8e3ff5b7b2c933af1d94bccf61358a48e0bb3a197d04588',
  'fix-selector.retirement-recovery-required': '3d145f76da1504860fcfa9a4d4aeb7edc2cd4690cb4da9c742016ae2cae5b482',
  'fix-selector.state-lock-fenced': '190b3ecc36a47fd3a352c1bee48798f2a997cc355adb97f44353f7faecbeec69',
  'fix-selector.state-lock-held': 'e73917addba1e242d3723b8d0cac910f33de4eb3c3803c99ab733223de510cc1',
  'fix-selector.state-lock-released-late': '639d31c17155be32222688c520a3d01cb21db3b4892e157ed4656b9e78ae4adb',
  'gaps.coarse-store-lock-fenced': '078acc716cc4c9e023c3907629d9315848df69447e5c7d1764baecc3096d8e1f',
  'gaps.coarse-store-lock-held': '6e0f40ed85cb07ba10c10f0da131e8fcfa80560b7272ab878a20a9326a83ee91',
  'heal.coarse-store-lock-fenced': '4dc143eb118b16123045ec9f8bb1d5cc50fa0e7b318684c925102fc51edd2a71',
  'heal.coarse-store-lock-held': 'd75105d146dc92120fa351ebdfc2fdef6cc24c059b380e982fe913b3a988ad1d',
  'heal.state-lock-fenced': '0e953793336959eeb86c7674c563a8f5c8d7beb62aa887d74237660e1f5b2340',
  'heal.state-lock-held': 'b61fdc82b9e4dac289094ea14c1f0cae25bab74f961cb971e270aea81c7ad38f',
  'heal.state-lock-released-late': '84fa5a18acb6a1aab70c454b52728f532e3189eedf747a464eb65270904dc4f7',
  'lock.order-invariant': '21fe074e5cc16d2a79deb2cc0eb37f66bf7afebca10e9bb6d6fc65a5413559fc',
  'plan.coarse-store-lock-fenced': '08890cb6165248a1a20e81d1a2c86ceef1978472de74882ba86faabdd8812beb',
  'plan.coarse-store-lock-held': '35690023d352412164b4261ea52f5d68d8070e41de35d8aafb7be5231087f321',
  'plan.privacy-disclosure-required': '0aca6e42cd1c4f8630c14161cbc4d5ca0308456668511120639321c138150851',
  'plan.retirement-recovery-required': '8103585d92f6d3579151e1b05913c9c19f5dd6b449f1c8cb50c238d16fc047eb',
  'reconcile.retirement-recovery-required': '1d383407ea716a8a4bb743eb04e68734c1405475b4e5310b26aca17f7069d5ce',
  'regenerate.coarse-store-lock-fenced': 'f0111b8e281b079ac78322a5863f7acdeb2cc13f5f16c41b15d8dd339813f716',
  'regenerate.coarse-store-lock-held': '9e36d4371f94c30bd422e201c76175604dfdc07dd395b858ddfb6ed087aeb65b',
  'regenerate.cross-origin-candidates': '284a551981c0eeabceae86ea581fc702609e3847f5e495b7e6635073805e2cd5',
  'regenerate.degraded-scan': 'd60ec0420e2d6ab912ed097085cca50deec591aefed106b6ab2c78776ea326f6',
  'regenerate.no-candidates': '5a95cad30daa488ab7726d858bbfd41a8bb46f94c017ce083df3f353d881bbf1',
  'regenerate.origin-unrecorded': 'dce0242dd1b1e76af6d8fd6c1de0b28cbf224a153a4ea5c886b743ebb791fd57',
  'regenerate.proposal-slot-occupied': '7fc553886ad505bb6e184afee134ba2df1facc632ff70075c6400f776f6c56bc',
  'regenerate.retirement-recovery-required': '019bd2f398cc272083aec0344442203b773eba8531486e7c82ff41a96e017564',
  'regenerate.signature-unresolvable': '3274be4ff90c8b54c9783779bb7a17417524c952423de3f5134a548855147593',
  'regenerate.unconfigured': 'd958c204bf53fff8e1e027e7155660540be149a363b36bbfa1126060e785a392',
  'retire.already-retired': '0bb40f0bade70f7c1c7a50464ee4ac36becb43f94ca5f6bb27448b39e058adb8',
  'retire.confirm-requires-bar-or-no-evidence': '9cd89a2eb19b8b42c3d030104052d8191a8f3ef1dfa2238a2c489d25aa6423c6',
  'retire.no-evidence-requires-confirm': '5a1cd796084be44492545dcf7b54409dd77f05bd3786bd84b2bc5b94ba068999',
  'retire.no-plan': '8aad94bd1902a3f83ff04b464bde8ae2c4d215896b4b4ba92259c66cfd730ba3',
  'retire.partial-failure': 'd6e4178a15394b3ba4d70c67a739c84c1d763ac5dbfcdae5529c967c190eaa55',
  'retire.privacy-workspace-not-ignored': '92e75fab83199c98b914dd62cc84e51ba1344230725ea80448477c328658b942',
  'retire.retirement-archive-divergent': 'e5e7f1db8abc0bebb66cfe008ecb85acddb3f5574d9757afdde5fabf4575ac68',
  'retire.retirement-journal-unreadable': '2e19cf2e2889366dcf5fb0214b0ad736a981a590311865f9d3f3bc5b54f8beae',
  'retire.retirement-lock-held': 'c89f27b7f0f72d7a2c6d00bb66b52b0cd3d5ee86ab41f74b93e9b18fc4d68ce7',
  'retire.retirement-record-unreadable': 'b40eb934a1cb15642c4a9f9a22c7210b6de39a6315e0f34673bfe3fd4f265f63',
  'retire.retirement-recovery-required': '1b21dc46c006b9ad31acc1d58130e82bc8991ffa8d1b304ef40ff935226482ae',
  'retire.state-lock-fenced': '70f9902788cdfd7ba1a02811ccd605df9e0bcc8afae447ca78b02b838782ae31',
  'retire.state-lock-held': 'dcc48e9b09da963fe87462d5718ae09046289eb5c493098467c0c79e66328768',
  'retire.state-lock-released-late': '2a36f985a9d9af001b0e6c4342a51ae0ce9ec51a7ad8b2b91c65eee0e2ea34e6',
  'scaffold.retirement-recovery-required': 'fd04eaaa5c76350892ca33fbbe4b238bb8629b78d97df82da34c1974da37c5ae',
  'scaffold.state-lock-fenced': 'ed712f981cf1e844b4c3ffd8b2785466d8bd8a621df860ccfbc8b7f29f0eda56',
  'scaffold.state-lock-held': '6a2481689e556232ff777712ffa54f48e8466d1f9f618edecb19ea0925be9294',
  'scaffold.state-lock-released-late': '5d538c915c8b1825bf2d5588317a465b4ce9e75900a328d7223d7a972cc2d88b',
  'sessions.coarse-store-lock-fenced': '058b5589f5c6456e09d0a5f3d4882ab523f083a94781a5948f972f12cbd9b603',
  'sessions.coarse-store-lock-held': '8088ee770f62ee40fe567a892c37a715ae24b70dd41208181d17dec0f0d0dc7f',
  'sessions.state-lock-released-late': '0e86b68ca62b0798828869326dcd6a6776ec6094018d9679e94f6cc4d8b8b77d',
  'suite-health.state-lock-released-late': '6959396c88a8c5c787e96c575c8e7b6a7a90db114de47372dea9a606051a6889',
  'triage.coarse-store-lock-fenced': '2591b571b539aa37d9fda6e457522f37ebc57577563d9e48d2d7736e0748f6ad',
  'triage.coarse-store-lock-held': '99156e5734b84716d596f5e4659dfc2ca50d7fbecf61d52b69c15168eb6831c1',
  'triage.invalid-hand-finished-registry': '6ab64da409c536fba598601dffff5112f2ec6272e3725812c4ab64d47f435a65',
  'triage.invalid-sidecar': '5eba2897e53f63da85b635a9789556d058a80303141ac54133133382b649e2e8',
  'triage.missing-sidecar': '21a7c5678941b03a11fa66945c51e12c3ecd21536a12bff8bf89f46973f1f835',
  'triage.proposed-exists': 'cbc7d7534eaa1c6eff8b1016287976ec3d7854763399cc6618449e52ce314c0d',
  'triage.retirement-recovery-required': 'cd1bc855229652dbacbccd885225135ad55b5ceed17881994dc6b3176e39ed6a',
  'triage.signature-unresolvable': '0089bb95fb1b8504ffed84b875e081189b6cf8dc07f408c46c6a2b46c8d0df38',
  'triage.state-lock-fenced': '66a37252fa86eda97cf062cf3c758bf710ec397caf550f36e39e3e75cad58405',
  'triage.state-lock-held': 'b48c3ff6ad95992cc75a894a585934d8d5e840103e40313ac6fe688fc55fe25f',
  'triage.state-lock-released-late': '728a5cc06140b667d6b6a70c5ca0a054f2f6b270fa6fef568178a0564aed618e',
  'triage.unconfigured': '9d1760686072591db6db7cac7ef8d2e277ead435597ff918d37d10694439e44a',
} as const;

function capture(argv: string[]): { output: string; exitCode: number | undefined } {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runExplain(argv, { log: (line) => output.push(line) });
    assert.equal(output.length, 1, 'every explain invocation writes one complete stdout envelope or report');
    return { output: output[0]!, exitCode: process.exitCode };
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('runExplain: --help returns before lookup and has the shared help synopsis', () => {
  const result = capture(['--help']);
  assert.equal(result.output, buildVerbHelpText('explain'));
  assert.equal(result.exitCode, undefined);
});

test('runExplain: bare invocation is a compact grouped list with the local-catalog preamble', () => {
  const result = capture([]);
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /This command reads the local refusal catalog only\. It never reads your workspace or contacts PostHog\./);
  assert.match(result.output, /\naccept:\n/);
  assert.match(result.output, /\ntriage:\n/);
  assert.ok(result.output.indexOf('accept:') < result.output.indexOf('doctor:'));
  assert.ok(result.output.indexOf('doctor:') < result.output.indexOf('explain:'));
  assert.ok(result.output.indexOf('explain:') < result.output.indexOf('regenerate:'));
});

test('runExplain: every migrated code has a byte-stable resolved JSON golden', () => {
  const goldenCodes = Object.keys(RESOLVED_JSON_GOLDENS).sort();
  assert.equal(goldenCodes.length, 82, 'the resolved JSON golden count changes only when a refusal code is deliberately added or removed');
  assert.deepEqual(
    goldenCodes,
    REFUSAL_REGISTRY
      .map((entry) => namespacedRefusalCode(entry))
      .sort(),
  );

  for (const nsCode of goldenCodes) {
    const entry = REFUSAL_REGISTRY.find((candidate) => namespacedRefusalCode(candidate) === nsCode);
    assert.ok(entry !== undefined, `${nsCode} must remain a registry row`);
    const result = capture([nsCode, '--json']);
    assert.equal(result.exitCode, undefined, `${nsCode} must resolve without a refusal`);
    assert.equal(
      createHash('sha256').update(result.output).digest('hex'),
      RESOLVED_JSON_GOLDENS[nsCode as keyof typeof RESOLVED_JSON_GOLDENS],
      `${nsCode} JSON fixture must remain byte-stable`,
    );
  }
});

test('runExplain: resolved/list/lookup variants carry schemaVersion 1 and usage errors use the shared refusal envelope', () => {
  const [resolved, list, unknown, ambiguous, usageError] = explainJsonFixtureEnvelopes().map((value) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
  assert.deepEqual(Object.keys(resolved), [
    'schemaVersion', 'kind', 'code', 'nsCode', 'verb', 'contentStatus', 'message', 'meaning', 'evidenceClass', 'jsonVisible', 'exitCode', 'tier', 'cases', 'override', 'nextSteps', 'coverage',
  ]);
  assert.deepEqual(Object.keys(list), ['schemaVersion', 'kind', 'coverage', 'entries']);
  assert.deepEqual(Object.keys(unknown), ['schemaVersion', 'kind', 'error', 'suggestions', 'coverage']);
  assert.deepEqual(Object.keys(ambiguous), ['schemaVersion', 'kind', 'error', 'candidates', 'coverage']);
  assert.deepEqual(Object.keys(usageError), ['error']);
  for (const envelope of [resolved, list, unknown, ambiguous]) assert.equal(envelope.schemaVersion, EXPLAIN_SCHEMA_VERSION);
  assert.equal(resolved.kind, 'resolved');
  assert.equal(list.kind, 'list');
  assert.equal(unknown.kind, 'unknown-code');
  assert.equal(ambiguous.kind, 'ambiguous-code');
  assert.deepEqual(usageError, { error: { code: 'usage-error', message: '--full requires --list. Usage: replaytest explain [<refusal-code>] [--list] [--full] [--json]' } });
});

test('runExplain: every resolved JSON case row carries its uniform situation outcome contract', () => {
  for (const entry of REFUSAL_REGISTRY) {
    const nsCode = namespacedRefusalCode(entry);
    const result = capture([nsCode, '--json']);
    assert.equal(result.exitCode, undefined, `${nsCode} must resolve without a refusal`);
    const envelope = JSON.parse(result.output) as { cases: Array<Record<string, unknown>> };
    for (const [index, row] of envelope.cases.entries()) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ['description', 'exitCode', 'message'],
        `${nsCode} case ${index} must carry exactly the declared per-case fields`,
      );
      assert.equal(Number.isInteger(row.exitCode), true, `${nsCode} case ${index} exitCode must be an integer`);
    }
  }
});

test('runExplain: every usage-error branch writes its real error in text and JSON modes', () => {
  const tooLongCode = 'a'.repeat(161);
  const cases = [
    { name: 'unknown flag', argv: ['--badflag'], message: 'Unknown flag: --badflag.\nUsage: replaytest explain [<refusal-code>] [--list] [--full] [--json]' },
    { name: 'two refusal codes', argv: ['first', 'second'], message: 'Usage: replaytest explain [<refusal-code>] [--list] [--full] [--json]' },
    { name: 'code with --list', argv: ['--list', 'regenerate.origin-unrecorded'], message: 'Use either a refusal code or --list. Usage: replaytest explain [<refusal-code>] [--list] [--full] [--json]' },
    { name: '--full without --list', argv: ['--full'], message: '--full requires --list. Usage: replaytest explain [<refusal-code>] [--list] [--full] [--json]' },
    { name: 'too-long refusal code', argv: [tooLongCode], message: 'Refusal codes may be at most 160 characters. Usage: replaytest explain [<refusal-code>] [--list] [--full] [--json]' },
  ];

  for (const usageCase of cases) {
    const text = capture(usageCase.argv);
    assert.equal(text.exitCode, 1, `${usageCase.name} must refuse in text mode`);
    assert.equal(text.output, usageCase.message, `${usageCase.name} must keep its real text refusal`);

    const json = capture([...usageCase.argv, '--json']);
    assert.equal(json.exitCode, 1, `${usageCase.name} must refuse in JSON mode`);
    assert.deepEqual(
      JSON.parse(json.output),
      { error: { code: 'usage-error', message: usageCase.message } },
      `${usageCase.name} must keep its real error in the JSON usage envelope`,
    );
  }
});

test('runExplain: unknown and ambiguous codes refuse honestly with bounded, deterministic choices', () => {
  const unknown = capture(['regenerate.origin-unrecorde', '--json']);
  assert.equal(unknown.exitCode, 1);
  const unknownJson = JSON.parse(unknown.output) as { kind: string; error: { code: string }; suggestions: string[] };
  assert.equal(unknownJson.kind, 'unknown-code');
  assert.equal(unknownJson.error.code, 'unknown-code');
  assert.ok(unknownJson.suggestions.length <= 3);
  assert.equal(unknownJson.suggestions[0], 'regenerate.origin-unrecorded');

  const ambiguous = capture(['unconfigured', '--json']);
  assert.equal(ambiguous.exitCode, 1);
  const ambiguousJson = JSON.parse(ambiguous.output) as { kind: string; error: { code: string }; candidates: string[] };
  assert.equal(ambiguousJson.kind, 'ambiguous-code');
  assert.equal(ambiguousJson.error.code, 'ambiguous-code');
  assert.deepEqual(ambiguousJson.candidates, ['doctor.unconfigured', 'regenerate.unconfigured', 'triage.unconfigured']);
});

test('runExplain: list JSON is compact by default and --full opts into resolved entries', () => {
  const compact = capture(['--list', '--json']);
  const compactJson = JSON.parse(compact.output) as { kind: string; entries: Array<Record<string, unknown>> };
  assert.equal(compact.exitCode, undefined);
  assert.equal(compactJson.kind, 'list');
  assert.deepEqual(Object.keys(compactJson.entries[0] ?? {}), ['nsCode', 'contentStatus']);

  const full = capture(['--list', '--full', '--json']);
  const fullJson = JSON.parse(full.output) as { coverage: Record<string, unknown>; entries: Array<Record<string, unknown>> };
  assert.equal((full.output.match(/"coverage"/g) ?? []).length, 1, 'a full list publishes its shared coverage block exactly once');
  assert.deepEqual(Object.keys(fullJson.entries[0] ?? {}), [
    'schemaVersion', 'kind', 'code', 'nsCode', 'verb', 'contentStatus', 'message', 'meaning', 'evidenceClass', 'jsonVisible', 'exitCode', 'tier', 'cases', 'override', 'nextSteps',
  ]);
  assert.deepEqual(Object.keys(fullJson.coverage), ['explained', 'recognized', 'total']);
});

test('runExplain: message-only status reaches direct lookup and both list renderers', () => {
  const directJson = JSON.parse(capture(['regenerate.unconfigured', '--json']).output) as { contentStatus: string };
  assert.equal(directJson.contentStatus, 'message-only');
  assert.match(capture(['regenerate.unconfigured']).output, /regenerate\.unconfigured — This code has no detailed explanation; the message is the full description\./);

  const compactText = capture(['--list']).output;
  assert.match(compactText, /regenerate\.unconfigured \(message only — no detailed explanation\)/);
  const compactJson = JSON.parse(capture(['--list', '--json']).output) as { entries: Array<{ nsCode: string; contentStatus: string }> };
  assert.equal(compactJson.entries.find((entry) => entry.nsCode === 'regenerate.unconfigured')?.contentStatus, 'message-only');
});

test('runExplain: human message-only detail appears once when meaning carries it and once when it does not', () => {
  const fullDescriptionLine = 'This code has no detailed explanation. The message above is the full description.';
  const carried = capture(['regenerate.unconfigured']).output;
  assert.equal((carried.match(/This code has no detailed explanation/g) ?? []).length, 1);
  assert.doesNotMatch(carried, /This code has no detailed explanation\.\s*The message above is the full description\./);

  const entry = REFUSAL_REGISTRY.find((candidate) => namespacedRefusalCode(candidate) === 'regenerate.unconfigured');
  assert.ok(entry !== undefined);
  const originalMeaning = entry.meaning;
  try {
    Reflect.set(entry, 'meaning', 'The workspace connection settings are absent.');
    const absent = capture(['regenerate.unconfigured']).output;
    assert.equal(absent.split('\n').filter((line) => line === fullDescriptionLine).length, 1);
  } finally {
    Reflect.set(entry, 'meaning', originalMeaning);
  }
});

test('runExplain: resolved JSON uses customer-readable code visibility instead of an internal tier letter', () => {
  const result = capture(['regenerate.origin-unrecorded', '--json']);
  assert.match(result.output, /"tier": "shown with a code"/);
  assert.doesNotMatch(result.output, /"tier":\s*"A"/);
});

test('runExplain: human message templates disclose interpolation markers only when they are present', () => {
  const tokenized = capture(['retire.no-plan']);
  assert.equal(tokenized.exitCode, undefined);
  assert.match(tokenized.output, /Message: No live plan found for "\{\{slug\}\}"/);
  // Literal string comparisons (never RegExp over the legend) so future legend
  // copy containing regex metacharacters can neither throw nor silently weaken.
  const tokenizedLines = tokenized.output.split('\n');
  const messageLineIndex = tokenizedLines.findIndex((line) => line.startsWith('Message: '));
  assert.ok(messageLineIndex >= 0, 'resolved render must contain a Message line');
  assert.equal(tokenizedLines[messageLineIndex + 1], EXPLAIN_TEMPLATE_LEGEND, 'legend must immediately follow the tokenized message line');

  const literal = capture(['regenerate.origin-unrecorded']);
  assert.equal(literal.exitCode, undefined);
  assert.ok(!literal.output.includes(EXPLAIN_TEMPLATE_LEGEND), 'literal messages must not carry the legend');

  const fullList = capture(['--list', '--full']);
  assert.equal(fullList.exitCode, undefined);
  const templateMessages = REFUSAL_REGISTRY.filter((entry) => entry.message.includes('{{')).length;
  assert.equal(templateMessages, 46, 'the eight state-lock-released-late templates each add one real {{files}} interpolation token to the mixed fixture');
  assert.equal(fullList.output.split(EXPLAIN_TEMPLATE_LEGEND).length - 1, templateMessages, 'each tokenized full-list message gets one adjacent legend');
});

test('runExplain: multi-situation codes preserve every current situation', () => {
  const casesFor = (nsCode: string): number => {
    const result = capture([nsCode, '--json']);
    return (JSON.parse(result.output) as { cases: unknown[] }).cases.length;
  };
  assert.equal(casesFor('retire.no-plan'), 3);
  assert.equal(casesFor('triage.signature-unresolvable'), 3);
  assert.equal(casesFor('regenerate.no-candidates'), 2);
  assert.equal(casesFor('retire.partial-failure'), 2);
  assert.equal(casesFor('retire.state-lock-held'), 5);
  assert.match(capture(['retire.state-lock-held']).output, /The recorded holder is dead but still inside the recovery grace window\./);
});

test('runExplain: a shared warning-and-refusal code renders role-aware text', () => {
  const result = capture(['privacy-workspace-not-ignored']);
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /^privacy-workspace-not-ignored — /);
  assert.doesNotMatch(result.output, /^retire\.privacy-workspace-not-ignored — /);
  assert.match(result.output, /^Exit code: 1 for the refusing role; continues \(exit 0\) for the warning role\.$/m);
  assert.doesNotMatch(result.output, /^Exit code: 1\.$/m);
});

test('runExplain: role-dependent outcome detection derives from case exit codes, not a code literal', () => {
  const original = REFUSAL_REGISTRY.find((entry) => entry.code === 'privacy-workspace-not-ignored');
  assert.ok(original !== undefined);
  assert.equal(hasRoleDependentOutcome(original), true);
  assert.equal(hasRoleDependentOutcome({
    exitCode: 7,
    cases: [
      { description: 'Synthetic refusing role', message: 'Synthetic refusal', exitCode: 7 },
      { description: 'Synthetic warning role', message: 'Synthetic warning', exitCode: 0 },
    ],
  }), true, 'a second dual-role fixture with an unrelated code shape must remain role-dependent');
  assert.equal(hasRoleDependentOutcome({
    exitCode: 7,
    cases: [
      { description: 'First refusing role', message: 'First refusal', exitCode: 7 },
      { description: 'Second refusing role', message: 'Second refusal' },
    ],
  }), false, 'multiple cases with the same effective outcome are not dual-role');
});

test('runExplain: coarse lock next steps add an action instead of repeating the live refusal tail', () => {
  const verbs = ['plan', 'triage', 'regenerate', 'heal', 'gaps', 'sessions', 'doctor'] as const;
  for (const verb of verbs) {
    const liveAdvice = coarseStoreLockAdviceClause('live', verb);
    const rendered = capture([`${verb}.coarse-store-lock-held`]).output;
    assert.equal(rendered.split(liveAdvice).length - 1, 1, `${verb} explain output must render the live advice once`);
    assert.match(rendered, /Next steps:\n- Retry after the coarse scan completes, or deliberately recover it with --steal-scan-lock\./);
  }
});
