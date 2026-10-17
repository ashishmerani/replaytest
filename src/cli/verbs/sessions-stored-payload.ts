// SEAM GUARD: this sanctioned internal module may import provider adapter TYPES but never provider data fields.
import type { AppScope, AppScopeDisclosure } from '../../app-scope.js';
import type { CapMetadata } from '../../providers/posthog-adapter.js';
import type { CompletionCounts, CompletionScanCoverage } from '../../selection.js';
import type { RankedJourneyWithCoverage, TopLevelEntryWithCoverage } from '../../dashboard/view-model.js';
import type { SuiteScanCapReason } from '../../suite-scan.js';
import type { WizardStepConfig } from '../../canonical-url.js';
import type { SessionsArgs } from '../args.js';

/** Honest provenance for the bounded suite scan that feeds `suiteMatch`. */
export interface SessionsSuiteScan {
  state: 'complete' | 'limited' | 'unavailable';
  note: string;
  filesScanned?: number;
  capped?: boolean;
  cappedBy?: SuiteScanCapReason;
  skippedStandardDirs?: boolean;
  unreadableFiles?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  reason?: string;
}

function appScopeCacheKeySuffix(appScope: AppScope | undefined): string {
  if (appScope === undefined) return '';
  return `|appScope=${JSON.stringify({ app: appScope.app, prefixes: [...appScope.prefixes].sort() })}`;
}

export function sessionsStoredFilterKey(args: SessionsArgs, config: WizardStepConfig, appScope: AppScope | undefined): string {
  const cacheArgs = ['sessions', '--json'];
  if (args.families) cacheArgs.push('--families');
  if (args.completed) cacheArgs.push('--completed');
  if (args.navigated) cacheArgs.push('--navigated');
  if (args.submitted) cacheArgs.push('--submitted');
  if (args.sinceHours !== undefined) cacheArgs.push('--since-hours', String(args.sinceHours));
  return `${JSON.stringify(cacheArgs)}|wizardStepParams=${JSON.stringify([...config.paramNames].sort())}${appScopeCacheKeySuffix(appScope)}|limit=undefined`;
}

export interface StoredSessionsPayload {
  provenance: 'exact' | 'coarse';
  meta: CapMetadata | null;
  signalAssessability?: unknown;
  refresh?: unknown;
  completionCounts?: CompletionCounts;
  /** Replayed with the counts so a cached scan cannot present a capped sample as a whole window. */
  completionCoverage?: CompletionScanCoverage;
  appScope?: AppScopeDisclosure;
  sessions: RankedJourneyWithCoverage[];
  families?: { provenance: 'exact' | 'coarse'; entries: TopLevelEntryWithCoverage[] };
  suiteScan?: SessionsSuiteScan;
  cache?: { scannedAt?: string; servedFromCache?: boolean; ttlRemainingMs?: number | null };
}

export function isStoredSessionsPayload(value: unknown): value is StoredSessionsPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provenance === 'exact' || record.provenance === 'coarse') &&
    Array.isArray(record.sessions) &&
    (record.meta === null || typeof record.meta === 'object')
  );
}
