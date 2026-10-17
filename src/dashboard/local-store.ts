/**
 * The dashboard's identity-gated, offline-first filesystem state.
 *
 * This module deliberately owns no provider access. Both the dashboard and
 * `sessions --stored` use the same v2 envelope reader, so an offline CLI
 * report cannot drift from the payload a cold dashboard start would inspect.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertArtifactPrivacyDisposition } from '../artifact-registry.js';

/** Dashboard-local state is separate from plans and generated tests. */
export const DASHBOARD_CACHE_DIR = path.join(process.cwd(), '.replaytest', 'cache');

/** The non-secret identity shared with the coarse-store fingerprint: host + project id. */
export interface DashboardProjectIdentity {
  host: string;
  projectId: string;
}

export type AutoCheckSetting = 'never' | '15m' | '1h';

const AUTO_CHECK_SETTINGS: readonly AutoCheckSetting[] = ['never', '15m', '1h'];

/**
 * Version of the fully composed `/api/sessions` payload stored on disk.
 *
 * Bump this whenever a served row or response-payload shape changes. Version
 * 4 adds the lifecycle-aware family counts and gap filtering contract — a
 * pre-4 snapshot cannot distinguish missing lifecycle evidence from zero
 * Passing paths, so it must be refreshed rather than rendering fabricated zeros.
 * Version 3 adds the row-level `plannable` marker the plan-button gating reads — a
 * pre-3 snapshot cannot distinguish "merged multi-create" from "scanned before
 * the field existed", so serving one would render a false disabled-reason.
 * Version 2 includes bug-signal badge fields; version 1 was the featureless
 * previous shape. Keeping this separate from the envelope format lets us read
 * an older envelope's safe provenance metadata while refusing to serve its
 * stale rows as if the current UI had produced them.
 */
// Version 6 adds the offline store/read-state facts and the snapshot totals
// used by the Sessions summary cards; older envelopes cannot provide them.
export const DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION = 6;

/** Version of the completed Suite Health response stored on disk. Version 3 refreshes payloads whose inventory shape predates unreadable-artifact reporting. */
export const DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION = 3;

/** Plain-English one-line copy for an automatic payload-schema refresh. */
export const DASHBOARD_PAYLOAD_SCHEMA_REFRESH_MESSAGE = 'Data was saved by an older version of this tool — refreshing.';

export function isAutoCheckSetting(value: unknown): value is AutoCheckSetting {
  return typeof value === 'string' && AUTO_CHECK_SETTINGS.includes(value as AutoCheckSetting);
}

function isDashboardProjectIdentity(value: unknown): value is DashboardProjectIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.host === 'string' && record.host.length > 0 && typeof record.projectId === 'string' && record.projectId.length > 0;
}

function sameDashboardProjectIdentity(left: DashboardProjectIdentity, right: DashboardProjectIdentity): boolean {
  return left.host === right.host && left.projectId === right.projectId;
}

/**
 * Makes the dashboard's persisted-cache identity match the coarse store's
 * host + project-id basis without reading a raw `.env` here. The adapter
 * treats blank/invalid hosts as the US default, and URL parsing also makes
 * equivalent host spellings (`https://…/`, a bare host, a port) compare the
 * same way.
 */
export function dashboardProjectIdentity(config: { host?: string; projectId?: string }): DashboardProjectIdentity | undefined {
  if (config.projectId === undefined || config.projectId === '') return undefined;

  let host = 'us.posthog.com';
  const configuredHost = config.host?.trim();
  if (configuredHost) {
    try {
      const parsed = new URL(configuredHost.includes('://') ? configuredHost : `https://${configuredHost}`);
      host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
      // Keep the adapter's default-host fallback when the stored value is not
      // a usable URL. This is an identity decision only; it never contacts a provider.
    }
  }
  return { host, projectId: config.projectId };
}

interface DashboardLastScanEnvelope {
  version: 2;
  identity: DashboardProjectIdentity;
  /** The canonical in-memory scan-cache key for the filters that built `payload`. */
  filterKey: string;
  /** The served row/payload shape; see `DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION`. */
  payloadSchemaVersion: number;
  /** A completed `/api/sessions` response, stored and later served unchanged. */
  payload: unknown;
}

/** A valid v2 dashboard snapshot, bound to its exact identity and filter key. */
export interface DashboardLastScanRead {
  payload: unknown;
  filterKey: string;
  identity: DashboardProjectIdentity;
  /** Absent on previous envelopes; callers may read provenance but must re-scan rows. */
  payloadSchemaVersion: number | undefined;
}

/**
 * Persisted result for one `suite-status` coverage window. Unlike the
 * Sessions envelope, this is workspace-local: the cache directory already
 * scopes it to one workspace and the key scopes it to the requested window.
 */
interface DashboardSuiteHealthEnvelope {
  version: 1;
  filterKey: string;
  payloadSchemaVersion: number;
  scannedAt: string;
  payload: unknown;
}

interface DashboardSuiteHealthRead {
  payload: unknown;
  scannedAt: string;
  payloadSchemaVersion: number | undefined;
}

interface DashboardSettingsEnvelope {
  version: 1;
  identity: DashboardProjectIdentity;
  settings: { autoCheck: AutoCheckSetting };
}

/**
 * Small filesystem seam for the dashboard's offline-first state. It has no
 * provider access: callers supply the already-safe project identity. The
 * last-scan reader intentionally returns only the stored payload, untouched;
 * callers must not merge fresh plan/test joins or replace its timestamp.
 */
export class DashboardLocalStore {
  private readonly lastScanPath: string;
  private readonly lastSuiteHealthPath: string;
  private readonly settingsPath: string;

  constructor(private readonly cacheDir: string = DASHBOARD_CACHE_DIR) {
    this.lastScanPath = path.join(cacheDir, 'dashboard-last-scan.json');
    this.lastSuiteHealthPath = path.join(cacheDir, 'dashboard-last-suite-health.json');
    this.settingsPath = path.join(cacheDir, 'dashboard-settings.json');
  }

  writeLastScan(identity: DashboardProjectIdentity, filterKey: string, payload: unknown): void {
    const envelope: DashboardLastScanEnvelope = {
      version: 2,
      identity,
      filterKey,
      payloadSchemaVersion: DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
      payload,
    };
    this.writeJson(this.lastScanPath, envelope);
  }

  /**
   * Reads a valid v2 envelope for this project before choosing a filter key.
   * This lets the offline CLI name the actual stored key when a caller asks
   * for filters the one-slot cache was not built under.
   */
  readLastScanEnvelopeForIdentity(identity: DashboardProjectIdentity): DashboardLastScanRead | undefined {
    const value = this.readJson(this.lastScanPath);
    if (typeof value !== 'object' || value === null) return undefined;
    const envelope = value as Partial<DashboardLastScanEnvelope>;
    if (envelope.version !== 2 || !isDashboardProjectIdentity(envelope.identity)) return undefined;
    if (!sameDashboardProjectIdentity(envelope.identity, identity)) return undefined;
    if (typeof envelope.filterKey !== 'string') return undefined;
    if (typeof envelope.payload !== 'object' || envelope.payload === null) return undefined;
    return {
      payload: envelope.payload,
      filterKey: envelope.filterKey,
      identity: envelope.identity,
      payloadSchemaVersion: Number.isInteger(envelope.payloadSchemaVersion)
        ? envelope.payloadSchemaVersion
        : undefined,
    };
  }

  /** Reports whether this workspace has any valid stored Sessions envelope for this identity. */
  hasLastScanForIdentity(identity: DashboardProjectIdentity): boolean {
    return this.readLastScanEnvelopeForIdentity(identity) !== undefined;
  }

  /**
   * Reads the keyed envelope even when its payload shape is old. This is
   * intentionally narrower than `readLastScan`: the server uses an old
   * envelope only for safe metadata (for example its original scan time)
   * while forcing a normal Check-style refresh for the rows themselves.
   */
  readLastScanEnvelope(identity: DashboardProjectIdentity, filterKey: string): DashboardLastScanRead | undefined {
    const envelope = this.readLastScanEnvelopeForIdentity(identity);
    return envelope?.filterKey === filterKey ? envelope : undefined;
  }

  /** Returns rows only when all three persisted-cache key components match. */
  readLastScan(identity: DashboardProjectIdentity, filterKey: string): unknown | undefined {
    const envelope = this.readLastScanEnvelope(identity, filterKey);
    return envelope?.payloadSchemaVersion === DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION
      ? envelope.payload
      : undefined;
  }

  /** Capacity is ONE window: writing any filterKey replaces the previous one (a key mismatch is a clean recompute, mirroring the Sessions single-file envelope). */
  writeLastSuiteHealth(filterKey: string, scannedAt: string, payload: unknown): void {
    const envelope: DashboardSuiteHealthEnvelope = {
      version: 1,
      filterKey,
      payloadSchemaVersion: DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION,
      scannedAt,
      payload,
    };
    this.writeJson(this.lastSuiteHealthPath, envelope);
  }

  /** Reads only a complete, keyed Suite Health envelope; callers decide TTL freshness. */
  readLastSuiteHealthEnvelope(filterKey: string): DashboardSuiteHealthRead | undefined {
    const value = this.readJson(this.lastSuiteHealthPath);
    if (typeof value !== 'object' || value === null) return undefined;
    const envelope = value as Partial<DashboardSuiteHealthEnvelope>;
    if (envelope.version !== 1 || envelope.filterKey !== filterKey) return undefined;
    if (typeof envelope.scannedAt !== 'string' || Number.isNaN(new Date(envelope.scannedAt).valueOf())) return undefined;
    if (typeof envelope.payload !== 'object' || envelope.payload === null) return undefined;
    return {
      payload: envelope.payload,
      scannedAt: envelope.scannedAt,
      payloadSchemaVersion: Number.isInteger(envelope.payloadSchemaVersion)
        ? envelope.payloadSchemaVersion
        : undefined,
    };
  }

  writeSettings(identity: DashboardProjectIdentity, settings: { autoCheck: AutoCheckSetting }): void {
    const envelope: DashboardSettingsEnvelope = { version: 1, identity, settings };
    this.writeJson(this.settingsPath, envelope);
  }

  readSettings(identity: DashboardProjectIdentity): { autoCheck: AutoCheckSetting } | undefined {
    const value = this.readJson(this.settingsPath);
    if (typeof value !== 'object' || value === null) return undefined;
    const envelope = value as Partial<DashboardSettingsEnvelope>;
    if (envelope.version !== 1 || !isDashboardProjectIdentity(envelope.identity)) return undefined;
    if (!sameDashboardProjectIdentity(envelope.identity, identity)) return undefined;
    if (typeof envelope.settings !== 'object' || envelope.settings === null) return undefined;
    const autoCheck = (envelope.settings as { autoCheck?: unknown }).autoCheck;
    return isAutoCheckSetting(autoCheck) ? { autoCheck } : undefined;
  }

  private readJson(filePath: string): unknown | undefined {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private writeJson(filePath: string, value: unknown): void {
    assertArtifactPrivacyDisposition('dashboard-local-cache', 'seam-only');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
  }
}
