// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProviderConfigStatus, saveProviderConfig, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { maybePrintVerbHelp } from '../help.js';
import { parseInitArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { describeIoError } from '../errors.js';
import { WORKSPACE_ROOT } from '../paths.js';
import { ReplaytestUserFacingError } from '../../user-facing-error.js';

// ---------------------------------------------------------------------------
// init — config status decisions + formatting (PURE; the .env read/write is not).
// ---------------------------------------------------------------------------

/** True iff EITHER a project id or an API key is on file — used by `init`'s no-flags branch to decide between showing the current (possibly partial) status and the initial setup hint. Distinct from `isConfigured` (which requires BOTH). Pure. */
export function hasAnyConfig(status: ProviderConfigStatus): boolean {
  return status.projectId !== undefined || status.hasApiKey;
}

/** `init`'s message when no flags were given and nothing is configured yet — tells the user which flags to pass (spec: "No flags + missing -> tell the user which flags to pass"). Pure. */
export function buildInitSetupHint(): string {
  return [
    'Not configured yet. Pass --project <id> and --token <key>, e.g.:',
    `  ${TOOL_NAME} init --project <id> --token <key>`,
  ].join('\n');
}

/** The fields an `init` invocation just wrote — drives the "(updated)" markers so a user changing e.g. `--token` can confirm the new value took. The key is never echoed, so presence alone cannot distinguish old from new. */
export interface InitUpdatedFields {
  project?: boolean;
  token?: boolean;
  host?: boolean;
}

/** Renders a `ProviderConfigStatus` under `heading` — the project id shown plainly (not a secret) and the key reported as PRESENT/absent only, NEVER its value. `host` is likewise not a secret and is shown plainly — the configured value, or an explicit "(default)" label when unset, so a user can always see which host a `sessions`/`plan` fetch will actually hit. A field named in `updated` gets an "(updated)" marker — the plain status view passes none. Pure string-builder. */
export function formatConfigStatus(status: ProviderConfigStatus, heading: string, updated: InitUpdatedFields = {}): string {
  const mark = (flag: boolean | undefined): string => (flag ? ' (updated)' : '');
  return [
    `${heading}:`,
    `  Project ID: ${status.projectId ?? '(not set)'}${mark(updated.project)}`,
    `  API key: ${status.hasApiKey ? 'set (••••)' : '(not set)'}${mark(updated.token)}`,
    `  Host: ${status.host ?? 'us.posthog.com (default)'}${mark(updated.host)}`,
  ].join('\n');
}

/** Renders the result of an `init` config write without calling a first write an update. */
export function formatInitConfigWriteStatus(
  status: ProviderConfigStatus,
  envAlreadyExisted: boolean,
  writtenFields: InitUpdatedFields,
): string {
  return formatConfigStatus(status, envAlreadyExisted ? 'Updated .env' : 'Wrote .env', envAlreadyExisted ? writtenFields : {});
}

/** `init`'s onboarding pointer once BOTH required fields are on file — the configure step otherwise dead-ends with no next command named. Pure. */
export function buildInitNextStepHint(): string {
  return `First touch: \`${TOOL_NAME} init\` (done) → \`${TOOL_NAME} sessions\` → \`${TOOL_NAME} plan <distinctId>\` → \`${TOOL_NAME} scaffold <slug>\` → run the generated test. Use \`${TOOL_NAME} doctor\` only when something is wrong; use \`${TOOL_NAME} preflight <slug>\` before a real run. Neither is a first-touch step.`;
}

// ---------------------------------------------------------------------------
// Command handlers — impure (fs / network / stdout). Thin wrappers around
// the pure functions above; not unit-tested (see module header).
// ---------------------------------------------------------------------------

/**
 * `.env` holds a real API key, so `init` must not leave it committable. The
 * pure decision logic takes the current `.gitignore` content (`undefined` =
 * no file) and decides whether to create the minimal credential guard,
 * append the needed ignore entries, and what to tell the customer. A fresh
 * guard protects credentials and replaytest's local artifacts; an existing
 * file preserves its prior lines and only appends missing coverage.
 */
export function buildGitignoreEnvGuard(existing: string | undefined): { updated?: string; note: string } {
  if (existing === undefined) {
    return {
      updated: '# replaytest created this file to protect credentials and local replay artifacts.\n.env\n.replaytest/\nnode_modules/\n',
      note: 'Created .gitignore — protects your .env (real API key) and replaytest local artifacts from being committed.',
    };
  }
  const lines = existing
    .split('\n')
    .map((line) => line.trim());
  const envCovered = lines.some((line) => line === '.env' || line === '/.env' || line === '.env*' || line === '*.env');
  const replaytestCovered = lines.some((line) => line === '.replaytest/' || line === '/.replaytest/' || line === '.replaytest' || line === '/.replaytest');
  if (envCovered && replaytestCovered) return { note: '.env and .replaytest/ are gitignored ✓' };
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const additions = [
    ...(envCovered ? [] : ['.env']),
    ...(replaytestCovered ? [] : ['.replaytest/']),
  ];
  return {
    updated: `${existing}${separator}${additions.join('\n')}\n`,
    note: `Added ${additions.join(' and ')} to .gitignore (.env holds your API key; .replaytest/ holds local artifacts).`,
  };
}

/** Injectable terminal seam so init's completion output is handler-testable. */
export interface InitRunDeps {
  log?: (line: string) => void;
}

function initWriteRefusal(error: unknown, envWritten: boolean, action: '.env' | '.gitignore'): ReplaytestUserFacingError {
  const envStatus = envWritten ? '.env was written' : '.env was not written';
  const remedy = action === '.env'
    ? 'Make the workspace writable, then retry `replaytest init`.'
    : 'Add .env and .replaytest/ to .gitignore, then retry `replaytest init`.';
  const detail = action === '.env'
    ? `${envStatus} (${describeIoError(error)})`
    : `${envStatus}, but .gitignore could not be updated (${describeIoError(error)})`;
  return new ReplaytestUserFacingError(
    `Could not initialize workspace "${WORKSPACE_ROOT}": ${detail}. ${remedy}`,
  );
}

export function runInit(argv: string[], deps: InitRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'init', deps.log)) return;
  const log = deps.log ?? ((line: string) => console.log(line));
  const args = parseInitArgs(argv);

  if (args.project === undefined && args.token === undefined && args.host === undefined) {
    const status = getProviderConfigStatus();
    log(hasAnyConfig(status) ? formatConfigStatus(status, 'Configured') : buildInitSetupHint());
    return;
  }

  const envPath = path.join(WORKSPACE_ROOT, '.env');
  const envAlreadyExisted = fs.existsSync(envPath);
  let envWritten = false;
  try {
    saveProviderConfig({ projectId: args.project, apiKey: args.token, host: args.host });
    envWritten = true;
  } catch (error) {
    throw initWriteRefusal(error, envWritten, '.env');
  }
  const status = getProviderConfigStatus();
  log(
    formatInitConfigWriteStatus(status, envAlreadyExisted, {
      project: args.project !== undefined,
      token: args.token !== undefined,
      host: args.host !== undefined,
    }),
  );

  const gitignorePath = path.join(WORKSPACE_ROOT, '.gitignore');
  let guard: { updated?: string; note: string };
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : undefined;
    guard = buildGitignoreEnvGuard(existing);
    if (guard.updated !== undefined) fs.writeFileSync(gitignorePath, guard.updated);
  } catch (error) {
    throw initWriteRefusal(error, envWritten, '.gitignore');
  }
  log(guard.note);
  if (status.projectId !== undefined && status.hasApiKey) log(buildInitNextStepHint());
}
