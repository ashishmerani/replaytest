// scripts/corpus/manifest.mjs — generator v2, manifest v2 + --resume logic.
// Manifest v3 adds three additive per-session fields (sessionId,
// markerReady, beaconFlushed) for per-ID capture-loss verification — see
// buildEntry below. Additive-only: a v2 manifest line (missing these fields)
// still parses and resumes fine, since parseManifest/completedIndices only
// ever look at `_meta`/`i`/`ok`.
//
// Per-session JSONL checkpoint (app, flow, cohort, distinct
// hints, needle/adversarial tags, replay on/off, timestamps); --resume skips
// completed entries. The manifest is append-only JSONL:
//   line 1  : {"_meta": { seed, corpus, corpusRun, count, generatedAt, ... }}
//   line 2+ : one session-result object per completed session
// Resume regenerates the SAME schedule from the meta (seed + count) and skips
// any schedule index `i` already present as an `ok` result — so an aborted 5h
// run resumes without double-driving.
//
// The PURE parts (serialize/parse a line, extract completed keys, filter a
// schedule) are unit-tested here; the file append/read is the driver's (impure).

/** Serializes the meta header line (first JSONL line). */
export function serializeMeta(meta) {
  return JSON.stringify({ _meta: meta });
}

/** Serializes one session-result entry to a single JSONL line. */
export function serializeEntry(entry) {
  return JSON.stringify(entry);
}

/**
 * Parses raw JSONL manifest text into { meta, entries }. Tolerant: blank lines
 * skipped; a line that fails JSON.parse is skipped (never throws — a partially
 * written final line from an abort must not break resume). The `_meta` line
 * (whichever line carries a `_meta` key) becomes `meta`; every other object is
 * an entry.
 */
export function parseManifest(text) {
  let meta = null;
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // torn final line from an abort — ignore
    }
    if (obj && typeof obj === 'object' && '_meta' in obj) {
      meta = obj._meta;
    } else {
      entries.push(obj);
    }
  }
  return { meta, entries };
}

/**
 * The set of schedule indices (`i`) already completed successfully. Only `ok:
 * true` entries count — a failed entry (`ok:false`) is eligible for a re-drive
 * on resume, so it is NOT added.
 */
export function completedIndices(entries) {
  const done = new Set();
  for (const e of entries) {
    if (e && e.ok === true && Number.isInteger(e.i)) done.add(e.i);
  }
  return done;
}

/**
 * Filters a freshly regenerated schedule down to the entries still to run,
 * given the completed-index set. PURE.
 */
export function filterResumable(schedule, completed) {
  return schedule.filter((s) => !completed.has(s.i));
}

/**
 * Builds the durable manifest entry for one driven session — the ground truth
 * every gate scores against. `result` carries the live-observed fields
 * (distinctId, landedUrl, sessionId, markerReady, beaconFlushed, error, ok,
 * timing).
 *
 * v3 fields (additive — see module header): `sessionId` (PostHog's
 * `get_session_id()`, null-safe when PostHog is absent/blocked), `markerReady`
 * (did the entry-readiness wait actually observe PostHog loaded before its
 * timeout — see drive-helpers.mjs `makeNav`/`waitForProviderReady`),
 * `beaconFlushed` (did the pre-close `about:blank` pagehide navigation
 * succeed — see drive-helpers.mjs `preCloseFlush`). All three default to
 * `null` when `result` doesn't carry them (defensive — driveSession always
 * sets them, but a v2-era caller must not crash buildEntry).
 */
export function buildEntry(sess, result) {
  return {
    i: sess.i,
    app: sess.app,
    kind: sess.kind,
    flow: sess.flow ? `${sess.flow.family}-${sess.flow.k}` : null,
    family: sess.flow ? sess.flow.family : null,
    variant: sess.flow ? sess.flow.k : null,
    anchorType: sess.anchorType,
    cohort: sess.cohort,
    replayOn: sess.replayOn,
    fast: sess.fast,
    adversarial: sess.adversarial,
    needle: sess.needle,
    userKey: sess.userKey,
    distinctId: result.distinctId ?? null,
    sessionId: result.sessionId ?? null,
    landedUrl: result.landedUrl ?? null,
    startedAt: result.startedAt ?? null,
    endedAt: result.endedAt ?? null,
    error: result.error ?? null,
    ok: result.ok === true,
    markerReady: result.markerReady ?? null,
    beaconFlushed: result.beaconFlushed ?? null,
  };
}
