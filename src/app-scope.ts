import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WIZARD_STEP_CONFIG_RELATIVE_PATH } from './canonical-url.js';

/** A named app boundary declared by the workspace. */
export interface AppScope {
  app: string;
  prefixes: string[];
}

export interface AppScopeConfig {
  apps: Record<string, string[]>;
  defaultApp?: string;
}

export interface InvalidAppScopeConfig {
  error: string;
}

export type AppScopeConfigResult = AppScopeConfig | InvalidAppScopeConfig;

export interface ScopedSessions<T> {
  sessions: T[];
  origins: string[];
  unattributableSessions: number;
  excludedSessions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): InvalidAppScopeConfig {
  return { error: `${WIZARD_STEP_CONFIG_RELATIVE_PATH} ${message}` };
}

/** Normalizes a declared HTTP(S) prefix before boundary matching. */
export function normalizeAppUrlPrefix(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return undefined;
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

/**
 * Matches a URL against a declared app prefix only at a URL boundary.
 *
 * A raw `startsWith` would let one host or path impersonate another, for
 * example `https://shop.example.evil` for `https://shop.example` or `/app2`
 * for `/app`.
 */
export function matchesAppUrlPrefix(url: string, prefix: string): boolean {
  const normalizedPrefix = normalizeAppUrlPrefix(prefix);
  if (normalizedPrefix === undefined) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const candidate = `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!candidate.startsWith(normalizedPrefix)) return false;
  const rest = candidate.slice(normalizedPrefix.length);
  return rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#');
}

/** Validates the app-scoping portion of the project-local JSON configuration. */
export function parseAppScopeConfig(raw: string): AppScopeConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid('must contain valid JSON.');
  }
  if (!isRecord(value)) return invalid('must be a JSON object.');

  const configuredApps = value.apps;
  const defaultApp = value.app;
  if (configuredApps === undefined && defaultApp === undefined) return { apps: {} };
  if (!isRecord(configuredApps)) return invalid('"apps" must be an object whose keys name apps and whose values are URL-prefix arrays.');

  const apps: Record<string, string[]> = {};
  for (const [name, prefixes] of Object.entries(configuredApps)) {
    if (name.trim() === '' || name.trim() !== name || /\s/.test(name)) {
      return invalid('"apps" has an invalid app name; names must be non-empty strings without whitespace.');
    }
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
      return invalid(`"apps.${name}" must be a non-empty array of HTTP(S) URL prefixes.`);
    }
    const normalizedPrefixes: string[] = [];
    const seen = new Set<string>();
    for (const [index, prefix] of prefixes.entries()) {
      if (typeof prefix !== 'string' || prefix.trim() !== prefix) {
        return invalid(`"apps.${name}" has an invalid prefix at index ${index}.`);
      }
      const normalized = normalizeAppUrlPrefix(prefix);
      if (normalized === undefined) {
        return invalid(`"apps.${name}" has an invalid HTTP(S) URL prefix at index ${index}.`);
      }
      if (seen.has(normalized)) {
        return invalid(`"apps.${name}" repeats the URL prefix "${prefix}".`);
      }
      seen.add(normalized);
      normalizedPrefixes.push(normalized);
    }
    apps[name] = normalizedPrefixes;
  }

  if (defaultApp === undefined) return { apps };
  if (typeof defaultApp !== 'string' || defaultApp.trim() === '' || defaultApp.trim() !== defaultApp) {
    return invalid('"app" must name one of the declared apps.');
  }
  if (apps[defaultApp] === undefined) return invalid(`"app" names "${defaultApp}", which is not declared in "apps".`);
  return { apps, defaultApp };
}

/** Reads the app-scoping declaration from the same project config as URL semantics. */
export function getAppScopeConfig(
  configPath = path.join(process.cwd(), WIZARD_STEP_CONFIG_RELATIVE_PATH),
): AppScopeConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return { apps: {} };
    return { error: `Could not read ${WIZARD_STEP_CONFIG_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseAppScopeConfig(raw);
}

export function isAppScopeConfigInvalid(result: AppScopeConfigResult): result is InvalidAppScopeConfig {
  return 'error' in result;
}

/** Resolves a command flag over the config's default app. */
export function resolveAppScope(config: AppScopeConfig, override: string | undefined): AppScope | InvalidAppScopeConfig | undefined {
  const app = override ?? config.defaultApp;
  if (app === undefined) return undefined;
  const prefixes = config.apps[app];
  if (prefixes === undefined) {
    const source = override === undefined ? '"app"' : `--app ${app}`;
    return { error: `${source} does not name an app declared in ${WIZARD_STEP_CONFIG_RELATIVE_PATH}.` };
  }
  return { app, prefixes: [...prefixes] };
}

export function isInvalidResolvedAppScope(value: AppScope | InvalidAppScopeConfig | undefined): value is InvalidAppScopeConfig {
  return value !== undefined && 'error' in value;
}

/**
 * Adds the active app scope to a per-slug CACHE FILE's identity, so a cached
 * result derived inside one boundary is never replayed as another's (or as an
 * unscoped whole-project result). Unscoped returns the empty string, which
 * keeps every existing cache filename exactly as it was.
 *
 * The scope is digested rather than spelled out because an app name is only
 * constrained to be non-empty and whitespace-free — it may legally contain
 * path separators, which have no business reaching a filename. The digest
 * covers the prefixes too, so re-pointing an app at different URLs is a
 * different cache rather than a stale hit under the same name.
 */
export function appScopeCacheFileSuffix(scope: AppScope | undefined): string {
  if (scope === undefined) return '';
  const identity = JSON.stringify({ app: scope.app, prefixes: [...scope.prefixes].sort() });
  return `.app-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function originFor(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sorted, de-duplicated set of HTTP(S) origins a list of witnessed URLs
 * came from. Non-HTTP(S) and unparseable URLs contribute nothing — the same
 * test `scopeSessionsByWitnessedUrls` applies when it decides a session has no
 * attributable page URL at all, so a per-row origin set and the corpus-level
 * `ScopedSessions.origins` can never disagree about what counts as an origin.
 *
 * Lives here because origin/boundary semantics are this module's job; callers
 * (the ranker, renderers) only ever consume neutral URL strings.
 */
export function witnessedOriginsOf(urls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string' || url === '') continue;
    const origin = originFor(url);
    if (origin !== undefined) origins.add(origin);
  }
  return [...origins].sort();
}

/**
 * Display form for a witnessed origin: the scheme is dropped because it is
 * noise in a narrow terminal column and never the thing that distinguishes one
 * customer property from another. The stored field keeps the full origin.
 */
export function displayOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//i, '');
}

/**
 * The raw-array scoping chokepoint used before every journey-ranking or
 * completion-count entry point. It only consumes neutral URL strings supplied
 * by its caller, so it has no provider vocabulary or provider dependency.
 */
export function scopeSessionsByWitnessedUrls<T>(
  sessions: readonly T[],
  witnessedUrls: (session: T) => readonly string[],
  scope: AppScope | undefined,
): ScopedSessions<T> {
  const origins = new Set<string>();
  let unattributableSessions = 0;
  let excludedSessions = 0;
  const retained: T[] = [];

  for (const session of sessions) {
    const urls = witnessedUrls(session).filter((url): url is string => typeof url === 'string' && url !== '');
    const pageUrls = urls.filter((url) => {
      const origin = originFor(url);
      if (origin === undefined) return false;
      origins.add(origin);
      return true;
    });
    if (scope === undefined) {
      retained.push(session);
      continue;
    }
    if (pageUrls.length === 0) {
      unattributableSessions += 1;
      continue;
    }
    if (pageUrls.some((url) => scope.prefixes.some((prefix) => matchesAppUrlPrefix(url, prefix)))) {
      retained.push(session);
      continue;
    }
    excludedSessions += 1;
  }

  return {
    sessions: retained,
    origins: [...origins].sort(),
    unattributableSessions,
    excludedSessions,
  };
}

export interface AppScopeDisclosure {
  scope?: AppScope;
  origins?: string[];
  unattributableSessions?: number;
  excludedSessions?: number;
}

/** Keeps unscoped, single-origin output unchanged while preserving scope honesty. */
export function appScopeDisclosure<T>(
  scoped: ScopedSessions<T>,
  scope: AppScope | undefined,
): AppScopeDisclosure | undefined {
  if (scope !== undefined) {
    return {
      scope: { app: scope.app, prefixes: [...scope.prefixes] },
      ...(scoped.unattributableSessions === 0 ? {} : { unattributableSessions: scoped.unattributableSessions }),
      ...(scoped.excludedSessions === 0 ? {} : { excludedSessions: scoped.excludedSessions }),
    };
  }
  return scoped.origins.length > 1 ? { origins: scoped.origins } : undefined;
}
