/**
 * Provider-configuration status helpers — the "is this workspace ready to talk
 * to the provider?" seam shared by the CLI entry and the dashboard (which
 * imports THIS module, never cli.js, keeping the CLI⇄dashboard static graph
 * acyclic). Sanctioned provider-seam importer: the lint zone list in
 * eslint.config.mjs names this module. This is also the deliberately narrow
 * local-identity surface for consumers that must not import the fetch-capable
 * adapter directly.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProviderConfigStatus } from './providers/posthog-adapter.js';
import { TOOL_NAME } from './cli/constants.js';

/** Minimal local `.env` parser for the inspector's project-identity check. */
function loadLocalDotEnv(envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function fingerprintHost(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'us.posthog.com';
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return 'us.posthog.com';
  }
}

/**
 * Local project identity only; reads `.env` and hashes its non-secret host and
 * project id. It deliberately lives outside the fetch-capable adapter so
 * local-only readers retain an adapter-free compiled graph.
 */
export function getPostHogProjectFingerprint(): string | undefined {
  const fileEnv = loadLocalDotEnv(path.join(process.cwd(), '.env'));
  const apiKey = fileEnv.POSTHOG_PERSONAL_API_KEY;
  const projectId = fileEnv.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) return undefined;
  return createHash('sha256').update(`${fingerprintHost(fileEnv.POSTHOG_API_HOST ?? '')}\n${projectId}`).digest('hex');
}

/** The exact preflight message every credential-gated command shows instead of letting a real fetch fail with a raw error. Pure. */
export function buildUnconfiguredHint(): string {
  return [
    `Not configured — run: ${TOOL_NAME} init --project <id> --token <key>`,
    'Credentials are read from the .env file in this workspace; shell environment variables are ignored by design.',
  ].join('\n');
}

/** True iff BOTH a project id and an API key are on file — the bar `sessions` requires before attempting a real fetch. Pure. */
export function isConfigured(status: ProviderConfigStatus): boolean {
  return status.projectId !== undefined && status.hasApiKey;
}
