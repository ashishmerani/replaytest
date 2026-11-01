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
  'accept.different-journey': '5e8605983c0222b00b696dbb78d71c5120c3f6880e2b35827a880eb76bae0d27',
  'accept.invalid-hand-finished-registry': 'a176723917e057255737557cfaacf859f950a5625e5954ede7af1ad466478fd3',
  'accept.invalid-live-plan': '7126e97b45f16f4fc0cc3d41d9acd8eefbfec746b0ba0fc93e910fbde80b956d',
  'accept.invalid-proposal': '2d7098d5ca028eb19544fdb4e759252bfd2fa8bec7eaf15795ed382bccff4443',
  'accept.live-plan-exists': '544dee6369fad73e6462990da5a0183edfcf20b567e9f35e6c05c2e40c08a1d8',
  'accept.missing-proposal': '610e9a7c5814023b6e0db0272acc8de4b06212fd35cf8a93b4c8b46ad8dd18f3',
  'accept.retired-no-resurrect': '76e15f2cc08c6ec0cc6296f089b50d5a136204e76d280be71b21e10aa39bee56',
  'accept.retirement-recovery-required': '4b6800f51f7dd3080e67dddcf2019d171f741477efe6a67346d2441fd1150b4d',
  'accept.state-lock-fenced': '99abb8fabe80fbc2e410e92cab6b6af026e552e6ee6af5469f8e7e393eaf2b4b',
  'accept.state-lock-held': '2d8e07fa4c58a653d5085a3c4e9479653b104236815478068c4e6a86998676d5',
  'accept.state-lock-released-late': 'e0407763c78e73750f51fe0016bb6465456ecc038c1e1a662c8f74e6914406d6',
  'auth-setup.privacy-disclosure-required': 'fc345e03da477debe1da5f645d8c7956d53efa62c54488b9f4e92cb7cbd810e1',
  'doctor.coarse-store-lock-fenced': '6dfcd7426e9a7eb72e7e2b8e430cdd6eeded1cd13e120e4114fd78f216799d07',
  'doctor.coarse-store-lock-held': 'f81c598f96f4a87f740bdc9384239f2790afa1e72bbc8c88328161f58981be33',
  'doctor.unconfigured': 'aada42a6a74488b304768926c6c10e0de7642fbcdbe17c32763c611c5389b54a',
  'explain.ambiguous-code': 'e0eef2dde45deb9a018679243ff7d907708245cefcb11127acfc4b8f9cddf900',
  'explain.unknown-code': '3becfa89572b111b9ffb984c972eeaa2087ae80c9dcdf67d685bc40688fde155',
  'fix-selector.fix-selector-spec-ambiguous': '9d606aeb704c376ec04f3de579dfc7a8685432f10a7fe157e512571c7aa65d25',
  'fix-selector.fix-selector-spec-scan-capped': 'e864fc3c507b25b85bb6c857137a749f4df1780903373e0593a2e777adc71fbb',
  'fix-selector.invalid-hand-finished-registry': 'e1da680af8b947a7fcbbfa72adc717962d87864f9831717536cbee70be6ceb99',
  'fix-selector.privacy-disclosure-required': '497112d60478147051f5dce0ee786dc4107227b3e6d3d6fd87ed1796e7aa6b55',
  'fix-selector.retirement-recovery-required': '7b03fa2ad350d4a1163ff0fd852abaed51c064eece26098cd6fa495468549226',
  'fix-selector.state-lock-fenced': 'cb753e57e0d90ec5498f8aaa7287c9a216043145495dcdd045a10ceb5ccf716f',
  'fix-selector.state-lock-held': 'f2c8aace339350f0f12904a4c25c09e2c0c172f778e7e62bdff4c9ddfff06770',
  'fix-selector.state-lock-released-late': '65dcbfca096b4882f3a36c5f4014b3bda6148ac00ff43826e9726913fcb9d038',
  'gaps.coarse-store-lock-fenced': 'd1fdcc472971d9ca7a5bcce7b65f24f9a00f0451a348fd39c5fe514c5e62965d',
  'gaps.coarse-store-lock-held': 'b86389895ba7196c0a50ab81dc60d296de86114424c0f80799a5a77e3f017253',
  'heal.coarse-store-lock-fenced': '784260264c7cfe966e0ffc8f2fe0db2e2363ea344a435188fa5c9919f7a0adbf',
  'heal.coarse-store-lock-held': 'c51c5a40e4973afa9fdca19a462fe866b5cab53e82920a2bb365394f19561a28',
  'heal.state-lock-fenced': 'a29fb8d3cbd16592550632e821369c9c42a0f155a23400ae7fba1fd7e87da6e4',
  'heal.state-lock-held': '9c51b2f2f8ae6d90b7f865a86f7b80580e036466b26f0b5baa51d71069459ddc',
  'heal.state-lock-released-late': 'b4ffe45203b253736b2de8858b23fa3d49f7d0824500fa84d0c085ac01a6a0b3',
  'lock.order-invariant': '1855d93eef8fbab75cd3c3b717018183369eff169c71e63ab501063e1f1bf4ca',
  'plan.coarse-store-lock-fenced': '496034394cee85187acfe5e74a4ad3a0de919752ea22f266bd5830b9c1540132',
  'plan.coarse-store-lock-held': 'd7a543521c9f79c0ab3817d312f8d7378976187902be0908c8ba69361c2b9f7c',
  'plan.privacy-disclosure-required': '3a3b6a0f59acc19714f3255ec3281bc7af5b7cd69f463d4f284f1e88f69afed5',
  'plan.retirement-recovery-required': 'ad3cceb5b7c496f587cce90607df563c9933383778748a5970f5c5d6534c126d',
  'reconcile.retirement-recovery-required': '9fd0eef0dbbe5c65fc83f62f5dca617a5c2267b4fd56d0c78db98a892b9efd44',
  'regenerate.coarse-store-lock-fenced': '019ab1e16bd014f6cea8149c906313d9710a6e65d13e59e66e705ac49540e5dc',
  'regenerate.coarse-store-lock-held': '48f7e8f3788d05913ff7bb06f6908ddf232ff7aa88e2d145ff6b6bd179c96c82',
  'regenerate.cross-origin-candidates': '3ad2aae7abf432a1683214072cd4e10f4daa0b24eb987e506de05f446b5a8309',
  'regenerate.degraded-scan': 'cee3cd39ee7394f0a0ba7accd67173212f201ae6c23c527d1ad2f3e92c1a720c',
  'regenerate.no-candidates': '3a195f724256a8cc638ae5f4283f05a1747cb50540c34261f8cddf619b9a0ed5',
  'regenerate.origin-unrecorded': 'af88f02dc9cb849daed766ca169d3cedf169c2008ca8a1fe1631e9145be85ab5',
  'regenerate.proposal-slot-occupied': '9f438da51851d7f90e9b9776c3f1c41abcd3f945aee5b8675ee7e1e9f6349c81',
  'regenerate.retirement-recovery-required': 'c34d35fb7e5b9225a88e27e406dbf6ab2a894be5161251bc4884094e66887d40',
  'regenerate.segmentation-changed': '0f181a22bf0a9c6f2ee3cc0449b24ce02ded2d5820029b4f6b933d36934be18d',
  'regenerate.signature-unresolvable': 'd5b6f85ab65a8ccac20aa700edb8bcf2487e44da3a11f9b2ae9b1a4b1bcfbc72',
  'regenerate.unconfigured': 'e03ca64b59c3876b08723a8a4a22330490e257ee013cd8ff9a4c4ddd03f8790b',
  'retire.already-retired': 'c62ba07189a493566a424b1ed63c4ab5921a767b0695614292ff70997af20e1a',
  'retire.confirm-requires-bar-or-no-evidence': '94459ca6eb9f4832c6e42ce8bb0f261ba0725d1410209ba6dc1c325eb3cc4226',
  'retire.no-evidence-requires-confirm': 'de77894a9f60da8188227adffd1479bd35d73306647b56fe97ad282ffcf41f64',
  'retire.no-plan': 'fa2b9d240f7e69b343753c18b569c35e63e3adb43289639d21b69b8574391804',
  'retire.partial-failure': 'aa461967dc93eb6ce8e829b29bb6b721958db0f10cb721ed2a0944f0c5a37f10',
  'retire.privacy-workspace-not-ignored': 'ba0e6c551df7e6f1a5d792771ebe6096ab3cb01fe8b093fcf55d952fe069ebd5',
  'retire.retirement-archive-divergent': '7c478ca9b4e176a3ebd30d195f61326f3d000e3224f3cbb142a2c9d33350bd3d',
  'retire.retirement-journal-unreadable': 'fc22d44574360a056976b6dde879f8a4c521be536969d1b312b8a6cf16677740',
  'retire.retirement-lock-held': '786171130a8f5ee57d84a237f066004e03c469ca19316fe1f69dfb666361202e',
  'retire.retirement-record-unreadable': 'd3705408e52fa743df1abcdeab9de048f10bc1983a02cc89b983891347541989',
  'retire.retirement-recovery-required': '06b2196ffd05aa4dd0071a12f82966ef693b9f51fbdef6bd5e2b5a054d80a8c0',
  'retire.state-lock-fenced': '9b0c4b173eb3976999fe3dd83dc8b3128f370ec0354fd82b8d1066d4c31d49cf',
  'retire.state-lock-held': '16bc85b08daecc0d316ccf1dfa97ccb93ac88913e06f5aaef9ec807f09403168',
  'retire.state-lock-released-late': '5917baa08040e01bcba7fb223ce4fa72f64e20a7744d68580d4e4226f67bb7ee',
  'scaffold.retirement-recovery-required': '64eb3c2e3aa0e87e09667d0a135c388bf9a5a68ec59350964ca06f44bae1f885',
  'scaffold.state-lock-fenced': 'db8c2d0a3f11d1cce0c0c0224910857c3708198c1d4b1e8d4e21d496604c4040',
  'scaffold.state-lock-held': 'c399051895a1ba031e5246d0c10dbf71fd086c8247cbca04262aded61e36248b',
  'scaffold.state-lock-released-late': '67a7419681ff4b541f36b2f6bf1cdb02de10d13d87bda3cc9f39c16f2bf18b9f',
  'sessions.coarse-store-lock-fenced': 'ade4592bd1419f527184b7aa9a59599bc3f121749a17a3f2a16f5582f142c8d3',
  'sessions.coarse-store-lock-held': '810552d942da748917ba1f076b974b845abe717b20be2b90bfaef5fe77a85bfb',
  'sessions.state-lock-released-late': '5be7e71831b12a16e12d6c44d6975acdf566a673869b6a84c4ef8f4ddaa97b2c',
  'suite-health.state-lock-released-late': '3e278cf1fa6c82c11f8d0c4055f401ca24d9a1cb7df29b04c7c1f7cb5531eb6e',
  'triage.coarse-store-lock-fenced': 'd3021c100dd554e003ad44eef17444ac57216dde3b340d1d462aae8506d2b1c5',
  'triage.coarse-store-lock-held': '68ec5da57ac5cf3ff0b3bb7c1faae990125b09b0d1fb02a7463a4b5ecd57284f',
  'triage.invalid-hand-finished-registry': '7407b2a6d24a2a65c78b4c55117efd3b24da9681b1bd658af063c95e324979cd',
  'triage.invalid-sidecar': '9f6b4ce790e5ed3002a70e7ac676a9dc368c407e1345be0ae120736cc7bf3167',
  'triage.missing-sidecar': '0633d2cbf4e4ab4077ae79cf34c3d16788ad0ffec4a7d55dcc77365552073d02',
  'triage.proposed-exists': '54449504b1b3ca44503fa43258e65dee9ee1d636068377417e591a773ac16dd5',
  'triage.retirement-recovery-required': 'e10d1b558837bde7fafa1385f424a980a2f0e7f8e2fae96e47a56b88bb425c73',
  'triage.signature-unresolvable': '270c707759d601db17d51d089122bf4fa09a50caadc85e74ff8ff3e2af929a25',
  'triage.state-lock-fenced': '5c5b245f059538d2e23fd240d7949320cde70e9f011e767980ed020cbbc7c83d',
  'triage.state-lock-held': 'b30b73794c9c0b19adf1412b6266385318c4cebe2ec2a1ef6311a87d01610269',
  'triage.state-lock-released-late': 'b1518b090877b1ac738cb19156c0fa9ad8671a2a7a102576c383d1459e7908d9',
  'triage.unconfigured': '975e72b07f77564f543001d7c8810c9f9f5c5a93582dedc79eae75ba899a524c',
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
  assert.equal(goldenCodes.length, 83, 'the resolved JSON golden count changes only when a refusal code is deliberately added or removed');
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
  assert.equal(templateMessages, 47, 'the eight state-lock-released-late templates each add one real {{files}} interpolation token to the mixed fixture');
  assert.equal(fullList.output.split(EXPLAIN_TEMPLATE_LEGEND).length - 1, templateMessages, 'each tokenized full-list message gets one adjacent legend');
});

test('runExplain: multi-situation codes preserve every current situation', () => {
  const casesFor = (nsCode: string): number => {
    const result = capture([nsCode, '--json']);
    return (JSON.parse(result.output) as { cases: unknown[] }).cases.length;
  };
  assert.equal(casesFor('retire.no-plan'), 3);
  assert.equal(casesFor('triage.signature-unresolvable'), 4);
  assert.equal(casesFor('regenerate.no-candidates'), 3);
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
