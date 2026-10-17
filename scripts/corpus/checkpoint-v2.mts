/** Checkpoint verifier: per-$session_id anti-join + truncation gate + context aggregate.
 * Usage: node --import tsx scripts/corpus/checkpoint-v2.mts <manifest.jsonl> <corpusRun>
 * Read-only vs PostHog; strictly sequential queries (chunks of 250).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env: NodeJS.ProcessEnv = { ...process.env };
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
env.POSTHOG_CLI_TOKEN = env.POSTHOG_PERSONAL_API_KEY ?? env.POSTHOG_CLI_TOKEN;
env.POSTHOG_CLI_ENV_ID = env.POSTHOG_PROJECT_ID ?? env.POSTHOG_CLI_ENV_ID;

function q(query: string): string {
  const r = spawnSync('posthog-cli', ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`CLI failed: ${(r.stderr ?? '').slice(0, 300)}`);
  return (r.stdout ?? '').replace(/\\n/g, '\n');
}

interface Entry { i?: number; app?: string; cohort?: string; fast?: boolean; sessionId?: string | null; markerReady?: boolean; beaconFlushed?: boolean; landedUrl?: string; distinctId?: string }
const [manifestPath, corpusRun] = [process.argv[2], process.argv[3]];
const entries: Entry[] = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e: Entry) => e.distinctId !== undefined);

const withSid = entries.filter((e) => e.sessionId);
const nonFast = withSid.filter((e) => !e.fast);
console.log(`manifest: ${entries.length} sessions (${withSid.length} with sessionId, ${nonFast.length} non-fast) markerReady=false count: ${entries.filter((e) => e.markerReady === false).length}, beaconFlushed=false count: ${entries.filter((e) => e.beaconFlushed === false).length}`);

// Per-$session_id join. Chunk size 100 — the CLI truncates large responses silently.
// Earlier 250-id chunks lost their tail rows and graded as 44% phantom "absent".
const found = new Map<string, { ev: number; marked: number; lastUrl: string }>();
const CHUNK = 100;
for (let c = 0; c < withSid.length; c += CHUNK) {
  const chunk = withSid.slice(c, c + CHUNK);
  const uniqueInChunk = new Set(chunk.map((e) => e.sessionId));
  const ids = [...uniqueInChunk].map((s) => `'${s}'`).join(',');
  const out = q(`SELECT properties.$session_id AS sid, count() AS ev, countIf(properties.corpus_run = '${corpusRun}') AS marked, argMax(toString(properties.$current_url), timestamp) AS last_url FROM events WHERE properties.$session_id IN (${ids}) GROUP BY sid`);
  let rows = 0;
  for (const row of out.split('\n')) {
    const cells = row.replace(/^"|"$/g, '').split('|');
    if (cells.length >= 4 && cells[0].trim().length > 30) {
      rows++;
      found.set(cells[0].trim(), { ev: Number(cells[1]), marked: Number(cells[2]), lastUrl: cells[3].trim() });
    }
  }
  // Rows < ids queried should ONLY come from genuinely-absent sessions. A shortfall larger
  // than the plausible-absent margin on a chunk this size = truncated/misparsed response —
  // Refuse to grade rather than report phantom loss: earlier 250-id chunks silently lost
  // tail rows while every session was present.
  if (rows < uniqueInChunk.size * 0.5) {
    throw new Error(`chunk at offset ${c}: ${rows}/${uniqueInChunk.size} rows returned — response truncated or misparsed; NOT gradable (do not read this as loss)`);
  }
}

// Group manifest entries by PostHog $session_id — repeat/power users driven back-to-back in one
// context SHARE a session id (no 30-min gap => PostHog continues the session). Per PostHog session,
// the expected last URL is the LAST manifest entry's landing (proven on rb1: all 4 shared-sid pairs
// matched the later entry exactly).
const bySid = new Map<string, Entry[]>();
for (const e of nonFast) {
  const list = bySid.get(e.sessionId!) ?? [];
  list.push(e);
  bySid.set(e.sessionId!, list);
}
let absent = 0, unmarked = 0, agree = 0, disagree = 0, mergedGroups = 0;
const disagreements: string[] = [];
for (const [sid, group] of bySid) {
  if (group.length > 1) mergedGroups++;
  const hit = found.get(sid);
  if (!hit) { absent++; continue; }
  if (hit.marked === 0) unmarked++;
  const last = group[group.length - 1];
  const landedPath = (last.landedUrl ?? '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const lastPath = hit.lastUrl.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (landedPath && lastPath === landedPath) agree++;
  else { disagree++; if (disagreements.length < 8) disagreements.push(`${last.app}/${last.cohort}: manifest=${landedPath} posthog=${lastPath}`); }
}
console.log(`posthog-session groups: ${bySid.size} (${mergedGroups} merged multi-drive groups — directly observed, no allowance)`);

const lossPct = (100 * (absent + unmarked)) / Math.max(1, nonFast.length);
const agreePct = (100 * agree) / Math.max(1, agree + disagree);
console.log(`\nAnti-join (non-fast, n=${nonFast.length}): absent=${absent} fully-unmarked=${unmarked} -> loss=${lossPct.toFixed(1)}% (tripwire >2%)`);
console.log(`Truncation gate: last-URL agreement ${agree}/${agree + disagree} = ${agreePct.toFixed(1)}% (gate >=95%)`);
for (const d of disagreements) console.log(`   ${d}`);

// context aggregate
console.log('\nAggregate:', q(`SELECT count() AS events, count(DISTINCT properties.$session_id) AS sessions, count(DISTINCT distinct_id) AS identities FROM events WHERE properties.corpus_run = '${corpusRun}' OR toString(properties.$current_url) LIKE '%corpusRun=${corpusRun}%'`).trim());
console.log(`\nCHECKPOINT: ${lossPct <= 2 && agreePct >= 95 ? 'PASS' : 'FAIL'} (provisional until a settle re-read >=10 min later matches)`);
