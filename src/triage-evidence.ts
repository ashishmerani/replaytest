/**
 * Local-only, single-slug selector-freshness handoff. This intentionally does
 * not share the Suite Health heal envelope: a standalone triage must never
 * erase another slug's observed run or diagnosis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeStateFile, type StatePublicationLedger } from './state-writes.js';
import type { StateLockHandle } from './state-lock.js';
export interface PersistedSelectorPatch {
  oldLocator: string;
  freshLocator: string;
  /**
   * The strongest recorded alternate that fresh traffic also validated for
   * this matched step. Additive: older evidence has no stability option, and
   * must keep parsing and applying the fidelity patch unchanged.
   */
  stabilityCandidate?: { strategy: string; locator: string };
  /**
   * How the sidecar↔fresh steps were paired for this comparison. A
   * `position` pairing is low-confidence (labels differed) and is treated as
   * informational by default. Optional + additive: basis-less evidence written
   * before keeps parsing and is classified from the locator strings alone.
   */
  basis?: 'action-label' | 'position';
  /**
   * The sidecar step this patch was paired against — persisted so
   * `fix-selector --from-triage-verdict` can locate the step's SITE in the spec
   * even when neither the old nor the fresh locator survives a hand-edit
   * (location only — never a new source of apply authority; the verdict
   * taxonomy this feeds is user-locked and unchanged by these fields). All
   * three are optional + additive: evidence persisted before lacks them
   * and keeps parsing/working exactly as it did (`stepIndex` absent ⟺
   * anchor-based location is skipped, never guessed).
   */
  stepAction?: 'fill' | 'click';
  stepLabel?: string;
  /** 0-based index into the ORIGINAL sidecar's `steps` array (mirrors `SelectorMatch.sidecarIndex`, triage.ts). */
  stepIndex?: number;
}

/**
 * Selector-ladder rungs, strongest → weakest, mirroring the priority order in
 * `src/selector.ts` `recommendSelector` (that file stays the read-only source
 * of truth for the ladder; this is a pure classifier over the emitted locator
 * EXPRESSION, kept here in the local-only module so both `triage.ts` and
 * `selector-apply.ts` can share it without either importing a provider adapter).
 */
export type SelectorRung = 'testid' | 'role' | 'label' | 'placeholder' | 'id' | 'text' | 'structural';

const LADDER_RANK: Record<SelectorRung, number> = {
  testid: 1,
  role: 2,
  label: 3,
  placeholder: 4,
  id: 5,
  text: 6,
  structural: 7,
};

/**
 * Classifies a Playwright locator EXPRESSION (e.g. `getByRole('button', …)`,
 * `locator('#name')`) to its ladder rung by leading shape. Returns `undefined`
 * for anything we can't confidently rank (so callers fail OPEN — never invent a
 * refusal for a shape we don't recognize). `locator('#id')` (a single id
 * selector, no descendant/`.nth`) is rung `id`; every other `locator(...)` form
 * is the structural fallback.
 */
export function classifyLocatorRung(locator: string): SelectorRung | undefined {
  const trimmed = locator.trim();
  if (trimmed.startsWith('getByTestId(')) return 'testid';
  if (trimmed.startsWith('getByRole(')) return 'role';
  if (trimmed.startsWith('getByLabel(')) return 'label';
  if (trimmed.startsWith('getByPlaceholder(')) return 'placeholder';
  if (trimmed.startsWith('getByText(')) return 'text';
  if (trimmed.startsWith('locator(')) {
    return /^locator\('#[^'\s]+'\)$/.test(trimmed) ? 'id' : 'structural';
  }
  return undefined;
}

/**
 * True when `freshLocator` sits on a strictly WEAKER rung than `oldLocator`
 * (e.g. `getByRole(...)` → `locator('#name')`). If either side is
 * unclassifiable the answer is `false` (fail open — a shape we can't rank is
 * never treated as a downgrade).
 */
export function isSelectorDowngrade(oldLocator: string, freshLocator: string): boolean {
  const oldRung = classifyLocatorRung(oldLocator);
  const freshRung = classifyLocatorRung(freshLocator);
  if (oldRung === undefined || freshRung === undefined) return false;
  return LADDER_RANK[freshRung] > LADDER_RANK[oldRung];
}

export interface PatchActionability {
  actionable: boolean;
  /** Populated only when `actionable` is false — an honest, human-readable why. */
  reason?: string;
}

/**
 * single actionability rule, shared by triage's report labelling and
 * fix-selector's patch counting so the two never diverge:
 * 1. old locator IS the threaded failing locator → actionable (the
 *      carve-out: replacing a broken strong locator with a working weaker one
 *      is exactly the point).
 *   2. position-basis pairing → informational (low-confidence: labels differed).
 *   3. strictly-weaker-rung replacement → informational.
 *   4. otherwise → actionable.
 */
export function classifyPatchActionability(
  patch: { oldLocator: string; freshLocator: string; basis?: 'action-label' | 'position' },
  failingLocator: string | undefined,
): PatchActionability {
  if (failingLocator !== undefined && failingLocator.length > 0 && patch.oldLocator === failingLocator) {
    return { actionable: true };
  }
  if (patch.basis === 'position') {
    return { actionable: false, reason: 'position-basis pairing (labels differed) — shown, not proposed as a patch' };
  }
  if (isSelectorDowngrade(patch.oldLocator, patch.freshLocator)) {
    return { actionable: false, reason: 'weaker-rung replacement — shown, not proposed as a patch' };
  }
  return { actionable: true };
}

export interface PersistedTriageEvidence {
  kind: 'triage-selector-freshness';
  version: 1;
  slug: string;
  generatedAt: string;
  selectorFreshness: {
    checked: boolean;
    changed: PersistedSelectorPatch[];
    reason?: string;
  };
  /** The locator named by the latest matching Playwright failure, if unambiguous. */
  failingLocator?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural parser: unknown/corrupt local state is never trusted as a patch. */
export function parsePersistedTriageEvidence(value: unknown): PersistedTriageEvidence | undefined {
  if (
    !isRecord(value) ||
    value.kind !== 'triage-selector-freshness' ||
    value.version !== 1 ||
    typeof value.slug !== 'string' ||
    typeof value.generatedAt !== 'string' ||
    !isRecord(value.selectorFreshness) ||
    typeof value.selectorFreshness.checked !== 'boolean' ||
    !Array.isArray(value.selectorFreshness.changed)
  ) {
    return undefined;
  }
  const changed = value.selectorFreshness.changed.flatMap((change) =>
    isRecord(change) && typeof change.oldLocator === 'string' && typeof change.freshLocator === 'string'
      ? [
          {
            oldLocator: change.oldLocator,
            freshLocator: change.freshLocator,
            ...(change.basis === 'action-label' || change.basis === 'position'
              ? { basis: change.basis as 'action-label' | 'position' }
              : {}),
            // Additive stability candidate. Its value was selected from the
            // recorded sidecar alternates and validated by fresh traffic at
            // triage time; malformed optional data never invalidates a patch.
            ...(isRecord(change.stabilityCandidate) &&
              typeof change.stabilityCandidate.strategy === 'string' &&
              typeof change.stabilityCandidate.locator === 'string'
              ? {
                  stabilityCandidate: {
                    strategy: change.stabilityCandidate.strategy,
                    locator: change.stabilityCandidate.locator,
                  },
                }
              : {}),
            // Additive step-anchor fields. Each is independently optional —
            // a malformed/absent field is silently dropped (fail open), never
            // invalidating the whole patch entry. Older persisted evidence (no
            // anchor fields at all) parses identically to before.
            ...(change.stepAction === 'fill' || change.stepAction === 'click'
              ? { stepAction: change.stepAction as 'fill' | 'click' }
              : {}),
            ...(typeof change.stepLabel === 'string' ? { stepLabel: change.stepLabel } : {}),
            ...(typeof change.stepIndex === 'number' && Number.isInteger(change.stepIndex) && change.stepIndex >= 0
              ? { stepIndex: change.stepIndex }
              : {}),
          },
        ]
      : [],
  );
  if (changed.length !== value.selectorFreshness.changed.length) return undefined;
  const selectorFreshness: PersistedTriageEvidence['selectorFreshness'] = {
    checked: value.selectorFreshness.checked,
    changed,
    ...(typeof value.selectorFreshness.reason === 'string' ? { reason: value.selectorFreshness.reason } : {}),
  };
  return {
    kind: 'triage-selector-freshness',
    version: 1,
    slug: value.slug,
    generatedAt: value.generatedAt,
    selectorFreshness,
    ...(typeof value.failingLocator === 'string' && value.failingLocator.length > 0
      ? { failingLocator: value.failingLocator }
      : {}),
  };
}

export function triageEvidencePath(evidenceDir: string, slug: string): string {
  return path.join(evidenceDir, `${slug}.json`);
}

/** Writes exactly one slug's evidence; it never reads or mutates heal-latest.json. */
export function persistTriageEvidence(evidenceDir: string, evidence: PersistedTriageEvidence, stateLockHandle?: StateLockHandle, publicationLedger?: StatePublicationLedger): string {
  const target = triageEvidencePath(evidenceDir, evidence.slug);
  fs.mkdirSync(evidenceDir, { recursive: true });
  writeStateFile('triage-selector-evidence', target, `${JSON.stringify(evidence, null, 2)}\n`, { stateLockHandle, publicationLedger });
  return target;
}

/**
 * Pulls a single emitted locator expression out of the timeout's call log.
 * We only accept the standard generated-locator families and return nothing
 * when the failure does not name exactly one usable locator.
 */
export function extractFailingLocator(errorMessage: string | undefined, errorSnippet: string | undefined): string | undefined {
  const source = [errorMessage, errorSnippet].filter((part): part is string => typeof part === 'string').join('\n');
  const prefixes = ['getByRole(', 'getByText(', 'getByTestId(', 'getByLabel(', 'getByPlaceholder(', 'getByAltText(', 'getByTitle(', 'locator('];
  const candidates: string[] = [];
  for (const prefix of prefixes) {
    let offset = 0;
    while (offset < source.length) {
      const start = source.indexOf(prefix, offset);
      if (start === -1) break;
      const candidate = balancedCallAt(source, start);
      if (candidate !== undefined) candidates.push(candidate);
      offset = start + prefix.length;
    }
  }
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

function balancedCallAt(source: string, start: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

/**
 * `heal` keeps timeout rows outside its per-slug diagnosis list, so triage
 * resolves the matching file by basename and carries its unambiguous failing
 * locator into the separate single-slug evidence record.
 */
export function failingLocatorFromHealEnvelope(value: unknown, slug: string): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.notTrafficExplicable)) return undefined;
  const expectedName = `${slug}.spec.ts`;
  const locators = value.notTrafficExplicable.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.file !== 'string' || path.basename(entry.file) !== expectedName) return [];
    const locator = extractFailingLocator(
      typeof entry.errorMessage === 'string' ? entry.errorMessage : undefined,
      typeof entry.errorSnippet === 'string' ? entry.errorSnippet : undefined,
    );
    return locator === undefined ? [] : [locator];
  });
  const unique = [...new Set(locators)];
  return unique.length === 1 ? unique[0] : undefined;
}

export function readFailingLocatorFromHealState(healLatestPath: string, slug: string): string | undefined {
  try {
    return failingLocatorFromHealEnvelope(JSON.parse(fs.readFileSync(healLatestPath, 'utf8')) as unknown, slug);
  } catch {
    return undefined;
  }
}
