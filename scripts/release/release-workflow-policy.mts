/** Dependency-free workflow policy tables shared by the offline guard. */

export const WORKFLOW_RUNNER = 'ubuntu-24.04';

export const RELEASE_WORKFLOW = '.github/workflows/release.yml';
export const CI_WORKFLOW = '.github/workflows/ci.yml';
export const AUDIT_WORKFLOW = '.github/workflows/audit.yml';

/** Every workflow file this guard governs. A new workflow must be added here. */
export const WORKFLOW_PATHS: readonly string[] = [RELEASE_WORKFLOW, CI_WORKFLOW, AUDIT_WORKFLOW];

/**
 * The exact number of `uses:` lines each workflow is allowed to have. An exact
 * count, never "at least one": a guard that only checks the shape of the lines it
 * happens to find is silent about an action someone deleted or slipped in.
 */
export const EXPECTED_USES_COUNT: Readonly<Record<string, number>> = {
  [RELEASE_WORKFLOW]: 10,
  [CI_WORKFLOW]: 7,
  [AUDIT_WORKFLOW]: 2,
};

export const EXPECTED_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  [RELEASE_WORKFLOW]: ['workflow_dispatch'],
  [CI_WORKFLOW]: ['pull_request', 'push', 'schedule', 'workflow_dispatch'],
  [AUDIT_WORKFLOW]: ['pull_request', 'push', 'schedule', 'workflow_dispatch'],
};

/**
 * The publish job's `if:` in full. Pinned as an EXACT string rather than by
 * substring: a condition that is accidentally always-false (for example one
 * reading `github.event.inputs.dry_run`, which is a STRING, so `!` never negates
 * it) looks identical to a correct one in every dry run. Every other condition
 * that decides whether a publish may happen lives in the job's first step, where
 * a refusal is LOUD; a job-level `if:` on those would skip the job silently.
 */
export const PUBLISH_IF = 'if: ${{ !inputs.dry_run }}';

/** Commands that fetch and run code outside the lockfile. None may appear. */
export const BANNED_EXEC_TOKENS: readonly string[] = ['npx', 'npm exec', 'npm x', 'dlx', 'pnpx'];

/**
 * The publish command, in full, exactly as the workflow must write it.
 *
 * An exact literal rather than a required-flag list plus a banned-flag list: a
 * deny-list only ever models the neighbouring mistakes someone already thought
 * of, and this line has several. `echo npm publish …` keeps every required flag
 * and publishes nothing, forever, with nothing in the run looking wrong.
 * The tag comes from the preflight output checked against the packed manifest.
 * The summary explains which version an unversioned install will receive. `--registry`, `--otp`,
 * `--dry-run`, a reordering, or any flag invented after today are all closed by
 * the same comparison. If this line ever legitimately changes, change it here in
 * the same commit — that is the intended cost.
 */
export const PUBLISH_COMMAND = 'npm publish "$TARBALL" --provenance --access public --ignore-scripts --tag "$EXPECTED_DIST_TAG"';

/**
 * The guard steps' decision lines, pinned as EXACT text rather than by the
 * presence of the names they mention. Inverting one operator is the whole attack:
 * `||` -> `&&` in the actor test means the step refuses only when BOTH identities
 * are wrong, so a re-run triggered by someone else on the owner's dispatch sails
 * through — precisely the re-run attack the triggering-actor check was added for.
 */
export const GUARD_REF_TEST = 'if [ "$REF" != "refs/heads/main" ]; then';
export const GUARD_ACTOR_TEST = 'if [ "$ACTOR" != "$OWNER" ] || [ "$TRIGGERING_ACTOR" != "$OWNER" ]; then';
export const GUARD_PUBLISH_ENABLED_TEST = 'if [ "$PUBLISH_ENABLED" != "true" ]; then';

/** Any YAML block-scalar header: `|`, `>`, with a chomp and/or indent indicator. */
export const BLOCK_SCALAR_HEADER = new RegExp('^[|>](?:[+-][0-9]?|[0-9][+-]?)?$');

function guardBlock(condition: string, message: string): string {
  return [`          ${condition}`, `            echo ${message} >&2`, '            exit 1', '          fi'].join('\n');
}

/**
 * Each guard's WHOLE conditional — the test, the reason it prints, and the
 * `exit 1` that is the entire point of it.
 *
 * Pinning the `if [ … ]` line alone pins the CONDITION and leaves the CONSEQUENCE
 * free: changing one `exit 1` to `exit 0` keeps every condition, every message
 * and every operator exactly as designed, and refuses nobody. The workflow still
 * reads correctly to someone skimming it. So the block is pinned whole, and the
 * counts below back it up in case someone reformats rather than edits.
 */
export const PREFLIGHT_GUARD_BLOCKS: readonly string[] = [
  guardBlock(GUARD_REF_TEST, '"A release runs only from refs/heads/main; this dispatch used $REF."'),
  guardBlock(GUARD_ACTOR_TEST, '"Only $OWNER may release; dispatched by $ACTOR, re-run triggered by $TRIGGERING_ACTOR."'),
];

export const PUBLISH_GUARD_BLOCKS: readonly string[] = [
  guardBlock('if [ "$EXPECTED_RELEASE_POINT" != "true" ]; then', '"This run\'s commit was not confirmed as a release point; nothing was published."'),
  guardBlock(GUARD_PUBLISH_ENABLED_TEST, '"publishing is not enabled in this repository — set the NPM_PUBLISH_ENABLED repository variable to true"'),
  guardBlock(GUARD_REF_TEST, '"A release publishes only from refs/heads/main; this dispatch used $REF."'),
  guardBlock(GUARD_ACTOR_TEST, '"Only $OWNER may publish; dispatched by $ACTOR, re-run triggered by $TRIGGERING_ACTOR."'),
];

/**
 * The preflight safety steps, pinned as WHOLE lines. A substring pin is happy
 * with `node scripts/release/registry-version-check.mts || true`, which runs the
 * check, ignores its answer, and lets a duplicate publish through.
 */
export const PREFLIGHT_SAFETY_LINES: readonly (readonly [string, string, boolean])[] = [
  ['node scripts/release/registry-version-check.mts', 'the registry check that refuses a version already published', true],
  ['node scripts/release/release-plan.mts release-point', 'the release-point predicate and its enforce/report output', true],
  ['node scripts/release/release-plan.mts version', 'strict version, npm tag, registry parsing, and ordering checks', true],
  ['node scripts/release/release-plan.mts capabilities', 'the offline runner capability check', true],
];

/**
 * Suffixes that run a command and then throw its answer away. A step that cannot
 * fail is a step that is not a check, however carefully it is named.
 */
export const NEUTERING_SUFFIXES: readonly string[] = ['|| true', '; true', '&& true', '|| exit 0', '|| :'];

/** The release job's one command, pinned whole: its token can rewrite the repository. */
export const RELEASE_COMMAND = 'node release-candidate/release-plan.mts release';

/** The exact job set of each workflow — the discover-don't-list rule, one level down. */
export const EXPECTED_JOBS: Readonly<Record<string, readonly string[]>> = {
  [RELEASE_WORKFLOW]: ['preflight', 'publish', 'release'],
  [CI_WORKFLOW]: ['browser', 'quality', 'test'],
  [AUDIT_WORKFLOW]: ['audit'],
};

export const USES_LINE = new RegExp('^-?\\s*uses:\\s+(\\S+)\\s*(#.*)?$');
export const PINNED_USES = new RegExp('^actions/[A-Za-z0-9._-]+@[0-9a-f]{40}$');
export const VERSION_COMMENT = new RegExp('^#\\s+v[0-9]');

/** Permission scopes recognised by this offline guard; unknown scopes fail closed. */
export const PERMISSION_SCOPES = [
  'actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token',
  'issues', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses',
] as const;

export const BANNED_STEP_KEYS = ['if', 'continue-on-error', 'working-directory', 'shell', 'timeout-minutes'] as const;
/** Exact mapping keys in release.yml; additions require a deliberate matching edit. */
export const RELEASE_WORKFLOW_KEYS = ['name', 'on', 'permissions', 'concurrency', 'jobs'];
export const RELEASE_JOB_KEYS: Readonly<Record<string, readonly string[]>> = {
  preflight: ['name', 'runs-on', 'timeout-minutes', 'permissions', 'env', 'outputs', 'steps'],
  publish: ['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'env', 'outputs', 'steps'],
  release: ['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'permissions', 'env', 'steps'],
};
export const RELEASE_JOB_ENV_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  preflight: {
    VERSION: '${{ inputs.version }}', DRY_RUN: '${{ inputs.dry_run }}', ACTOR: '${{ github.actor }}',
    TRIGGERING_ACTOR: '${{ github.triggering_actor }}', OWNER: '${{ github.repository_owner }}',
    REF: '${{ github.ref }}', COMMIT_SHA: '${{ github.sha }}', NPM_TAG: '${{ inputs.npm_tag }}',
    PUBLISH_ENABLED: '${{ vars.NPM_PUBLISH_ENABLED }}',
  },
  publish: {
    VERSION: '${{ inputs.version }}', PUBLISH_ENABLED: '${{ vars.NPM_PUBLISH_ENABLED }}',
    ACTOR: '${{ github.actor }}', TRIGGERING_ACTOR: '${{ github.triggering_actor }}',
    OWNER: '${{ github.repository_owner }}', REF: '${{ github.ref }}', NPM_TAG: '${{ inputs.npm_tag }}',
    EXPECTED_RELEASE_POINT: '${{ needs.preflight.outputs.release_point_passed }}',
    EXPECTED_TARBALL_SHA256: '${{ needs.preflight.outputs.tarball_sha256 }}',
    EXPECTED_TARBALL_SHA512: '${{ needs.preflight.outputs.tarball_sha512 }}',
    EXPECTED_MODULE_SHA256: '${{ needs.preflight.outputs.module_sha256 }}',
    EXPECTED_DIST_TAG: '${{ needs.preflight.outputs.dist_tag }}',
  },
  release: {
    VERSION: '${{ inputs.version }}', ACTOR: '${{ github.actor }}',
    TRIGGERING_ACTOR: '${{ github.triggering_actor }}', OWNER: '${{ github.repository_owner }}',
    REF: '${{ github.ref }}', GH_TOKEN: '${{ github.token }}', NPM_TAG: '${{ inputs.npm_tag }}',
    EXPECTED_TARBALL_SHA256: '${{ needs.preflight.outputs.tarball_sha256 }}',
    EXPECTED_NOTES_SHA256: '${{ needs.preflight.outputs.notes_sha256 }}',
    EXPECTED_MODULE_SHA256: '${{ needs.preflight.outputs.module_sha256 }}',
    EXPECTED_PRERELEASE: '${{ needs.preflight.outputs.prerelease }}',
    EXPECTED_MAKE_LATEST: '${{ needs.preflight.outputs.make_latest }}',
    EXPECTED_BUNDLE_SHA256: '${{ needs.publish.outputs.bundle_sha256 }}',
  },
};
/** Exact step count and env sets, in workflow order; only the summary has env. */
export const RELEASE_STEP_ENV_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  preflight: Array.from({ length: 20 }, () => []),
  publish: [[], [], [], [], [], [], [], ['BUNDLE_PATH'], []],
  release: [[], [], [], [], [], [], []],
};
export const RELEASE_STEP_ENV_VALUES: Readonly<Record<string, readonly (Readonly<Record<string, string>>)[]>> = {
  preflight: Array.from({ length: 20 }, () => ({})),
  publish: [{}, {}, {}, {}, {}, {}, { BUNDLE_PATH: '${{ steps.attest.outputs.bundle-path }}' }, {}, {}],
  release: Array.from({ length: 7 }, () => ({})),
};
export const RELEASE_NEEDS: Readonly<Record<string, string>> = {
  preflight: '',
  publish: 'preflight',
  release: '[preflight, publish]',
};
export const RELEASE_OUTPUT_PRODUCERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  preflight: {
    tarball_sha256: '${{ steps.pack.outputs.tarball_sha256 }}',
    tarball_sha512: '${{ steps.pack.outputs.tarball_sha512 }}',
    notes_sha256: '${{ steps.notes.outputs.notes_sha256 }}',
    module_sha256: '${{ steps.notes.outputs.module_sha256 }}',
    dist_tag: '${{ steps.version.outputs.dist_tag }}',
    prerelease: '${{ steps.version.outputs.prerelease }}',
    make_latest: '${{ steps.version.outputs.make_latest }}',
    release_point_passed: '${{ steps.release-point.outputs.release_point_passed }}',
  },
  publish: { bundle_sha256: '${{ steps.attestation-bundle.outputs.bundle_sha256 }}' },
};
export const RELEASE_WRITE_GRANTS: readonly { workflow: string; job: string; scope: string }[] = [
  { workflow: RELEASE_WORKFLOW, job: 'release', scope: 'contents' },
  { workflow: RELEASE_WORKFLOW, job: 'publish', scope: 'id-token' },
  { workflow: RELEASE_WORKFLOW, job: 'publish', scope: 'attestations' },
];
/** SHA-256 pins over each safety script's exact run bytes, including indentation. */
export const RELEASE_SCRIPT_SHA256: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  preflight: {
    'Runtime floor — npm must be at least 11.5.1 for trusted publishing': '7152fad915ae982872117bdeae17392293273b7ab741b8742d84d2c98d2d02bf',
    'This commit is a release point on main': '21e7dfcb9c80e3e3e4e049b84953c4a9fd7e8fc23648c7b52b11f1dda6171aca',
    'The version and npm tag are valid': 'ee283756180a8dac436892685b7557d4db47069968a635cab743c6c7bccba562',
    "The runner's gh can create the release": 'b6dbf85177e488413ce037089baa00d2b4927c8b9d380b4a83d88f9800510b41',
    'The version is not on the registry yet': '29cbc332245aa7b8ba06fa2fb7a7731e1d4039f1841187843ff327782caeba80',
    'Pack and hash the tested package': 'dc129ac197e600b2cd0aa52ef4b8db08f6fcafa8c20f147791800455b2516848',
    'Release notes from CHANGELOG.md': '6b02feadd433cd65e1015870b5bfda5cf981a588aae43a3769fe7f497a401299',
    'Write the release summary': 'cc2e0b46751c5edb15b0080863e7b1a03fa0ab05e1d5ab2a1a466f54ebdff3f9',
    'Assemble the release-candidate artifact': 'e861316dc1f1c016ba16fb666f6fd38dd9f62b3c6f0460971d1129256375e352',
  },
  publish: {
    'The tested package and module match their hashes': '811cb30d0d10067e32e51520ca5bb31830f480ec57a3ceac55f396a025d9a5cd',
    'The package manifest and npm tag are valid': 'ec6922aa3f28d3bfe53f9f4d3926aa9231d85fde3c4cbe4cf59b7fcc33b86bd0',
    'Save the attestation bundle and its hash': '52c26c95cd62af4fe9ab784d2b436e5ec34a05304f4a7368eb85b57021cf7acb',
    'Check the registry, then publish': 'e4ebf187e34be4694af488e7539aef5cc0da9eddaa2aea1f369bb372607d6c4e',
  },
  release: {
    'The release files match what was tested': '34632675a1545c76450ce2c154a35272b8c112b384d8ad3bd0855e62a2eb321c',
    'Check the attestation': '693bbbc19b5998611ee182ef051afbe23b41a3e414829486f652fc6efea241b3',
    'Decide and create the release': '3056660e9dbec0b9900e153e2081525db86645c16c877ff9bfee65a59729cd64',
  },
};
export const ALLOWED_STEP_KEYS = ['name', 'id', 'uses', 'run', 'with', 'env', ...BANNED_STEP_KEYS];

export const PREFLIGHT_MANIFEST_STEP = 'A real release needs a publishable manifest';

export const PREFLIGHT_MANIFEST_GATE = 'if [ "$DRY_RUN" != "true" ]; then';

export const PREFLIGHT_MANIFEST_TEST = 'if (manifest.private) { console.error("This manifest is marked private; drop that flag when the public package is first seeded."); process.exit(1); }';

export const PREFLIGHT_MANIFEST_SCRIPT = [
  '          if [ "$DRY_RUN" != "true" ]; then',
  '            node --input-type=module -e \'const fs = await import("node:fs"); const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")); if (manifest.private) { console.error("This manifest is marked private; drop that flag when the public package is first seeded."); process.exit(1); } console.log("The manifest is publishable.");\'',
  '          else',
  '            echo "Dry run: nothing is published, so the manifest does not have to be publishable yet."',
  '          fi',
].join('\n');
