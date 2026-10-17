import { displayOrigin, type AppScopeDisclosure } from '../app-scope.js';

// Shared app-scope output helpers used by both sessions and gaps.

/** The command-boundary refusal for an invalid app declaration or selection. */
export function buildAppScopeRefusal(error: string): string {
  return `App scope refused — ${error} Fix .replaytest/config.json or choose a declared app with --app <name>.`;
}

/**
 * Scope status is output-only metadata; it never enters plans or sidecars.
 *
 * On the human surface the disclosure is PREPENDED — which app a result set
 * belongs to has to be readable before the rows are, not after a long table
 * has already been read as if it covered everything. Both human branches
 * (the unscoped multi-origin nudge and the scoped disclosure) lead; the
 * machine branch attaches an `appScope` key and has no ordering at all.
 */
export function appendAppScopeDisclosure(
  rendered: string,
  json: boolean,
  disclosure: AppScopeDisclosure | undefined,
): string {
  if (disclosure === undefined) return rendered;

  if (json) {
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    if (parsed.appScope !== undefined) return rendered;
    return JSON.stringify({ ...parsed, appScope: disclosure }, null, 2);
  }

  if (disclosure.scope === undefined) {
    // Dedupe on the DISPLAY form and count the deduped set: a workspace serving
    // `http://host` and `https://host` is one site to the customer, so the nudge
    // must say "1 site" — or better, not appear at all. The raw origins stay in
    // the JSON branch (the accepted contract); only the human line collapses.
    const sites = [...new Set((disclosure.origins ?? []).map(displayOrigin))];
    if (sites.length <= 1) return rendered;
    return `ⓘ This scan includes traffic from ${sites.length} sites: ${sites.join(', ')} — declare your app in .replaytest/config.json or use --app <name> to scope them.\n${rendered}`;
  }

  // Dedupe on the DISPLAY form, same idiom as the unscoped branch above: a
  // workspace declaring `http://host` and `https://host` for one app is one
  // site to the customer, so the scoped line names it once — matching the
  // dashboard's `Scoped to shop: shop.test.` word-for-word (the CLI and
  // dashboard must agree). The raw prefixes stay in the JSON branch and the
  // stored identity; only the human render collapses.
  const sites = [...new Set(disclosure.scope.prefixes.map(displayOrigin))];
  const lines = [
    `ⓘ Scoped to ${disclosure.scope.app}: ${sites.join(', ')}.`,
  ];
  if (disclosure.unattributableSessions !== undefined) {
    const label = disclosure.unattributableSessions === 1 ? 'session' : 'sessions';
    lines.push(`⚠ ${disclosure.unattributableSessions} ${label} carried no page URLs and can't be attributed to an app.`);
  }
  if (disclosure.excludedSessions !== undefined) {
    const label = disclosure.excludedSessions === 1 ? 'session' : 'sessions';
    const verb = disclosure.excludedSessions === 1 ? 'was' : 'were';
    lines.push(`ⓘ ${disclosure.excludedSessions} ${label} belonged to other apps and ${verb} excluded by your scope.`);
  }
  lines.push(rendered);
  return lines.join('\n');
}

export function scopedOutputDisclosure(disclosure: AppScopeDisclosure | undefined): AppScopeDisclosure | undefined {
  return disclosure?.scope === undefined ? undefined : disclosure;
}
