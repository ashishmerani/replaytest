// scripts/corpus/marker.mjs — generator v2, the attribution-marker URL builder.
//
// PURE, no I/O. Every ENTRY url carries
// `?corpus=<tag>&corpusRun=<runId>` (+ `&replay=off` per the stratification
// roll). The app-side init reads these query params once per entry and
// registers PostHog super properties; super props persist across the session,
// so ONLY the entry URL needs the params — interior navigation stays clean.
// No param → no corpus/corpus_run props registered (organic/baseline traffic
// unmarked, byte-identical behavior), which is why interior gotos MUST NOT be
// marked. `corpus_app` is registered unconditionally app-side (no param).

/**
 * Builds a marked ENTRY url from a base origin + pathname + marker.
 *   marker = { corpus, corpusRun, replayOff }
 * Preserves any pre-existing query string on `pathname` and appends the marker
 * params; a `#hash` is kept at the end. `corpus`/`corpusRun` are always added;
 * `replay=off` only when `replayOff` is true. Values are URL-encoded.
 */
export function buildEntryUrl(base, pathname, marker) {
  const trimmedBase = base.replace(/\/+$/, '');
  // Split off a hash fragment first so params insert before it.
  const hashIdx = pathname.indexOf('#');
  const hash = hashIdx === -1 ? '' : pathname.slice(hashIdx);
  const noHash = hashIdx === -1 ? pathname : pathname.slice(0, hashIdx);

  const qIdx = noHash.indexOf('?');
  const path = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
  const existingQuery = qIdx === -1 ? '' : noHash.slice(qIdx + 1);

  const params = new URLSearchParams(existingQuery);
  if (marker && marker.corpus) params.set('corpus', marker.corpus);
  if (marker && marker.corpusRun) params.set('corpusRun', marker.corpusRun);
  if (marker && marker.replayOff) params.set('replay', 'off');

  const query = params.toString();
  const slashPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${slashPath}${query ? `?${query}` : ''}${hash}`;
}

/**
 * Builds a plain (UNMARKED) interior url — base + pathname, no marker params.
 * Interior navigations must stay clean (super props already registered from the
 * marked entry); this helper exists so the driver never accidentally re-marks.
 */
export function buildInteriorUrl(base, pathname) {
  const trimmedBase = base.replace(/\/+$/, '');
  const slashPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${trimmedBase}${slashPath}`;
}
