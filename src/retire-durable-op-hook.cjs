const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const tracePath = process.env.REPLAYTEST_DURABLE_TRACE;
const killOp = process.env.REPLAYTEST_DURABLE_KILL_OP;
const killAt = Number(process.env.REPLAYTEST_DURABLE_KILL_AT ?? '0');
const killMatch = process.env.REPLAYTEST_DURABLE_KILL_MATCH ?? '';
const pauseOp = process.env.REPLAYTEST_DURABLE_PAUSE_OP;
const pauseMs = Number(process.env.REPLAYTEST_DURABLE_PAUSE_MS ?? '0');
const pauseBeforeOp = process.env.REPLAYTEST_DURABLE_PAUSE_BEFORE_OP;
const pauseMatch = process.env.REPLAYTEST_DURABLE_PAUSE_MATCH ?? '';
const releaseOnPath = process.env.REPLAYTEST_DURABLE_RELEASE_ON_PATH;
const workspaceRoot = process.env.REPLAYTEST_DURABLE_ROOT;
const operations = ['mkdirSync', 'writeFileSync', 'openSync', 'fsyncSync', 'renameSync', 'linkSync', 'copyFileSync', 'cpSync', 'unlinkSync', 'rmSync'];
const writeTrace = fs.writeFileSync;
const markerExists = fs.existsSync;

// Barrier mode. With RELEASE_ON_PATH set alongside PAUSE_OP, the after-op pause
// stops being a fixed sleep and becomes "hold until the observer says it has
// seen what it needed to see": poll for the marker in short slices, so the held
// resource is released the moment the marker lands rather than after an
// arithmetic guess at how long the observer needs. PAUSE_MS changes meaning
// with it — no longer a per-operation sleep but ONE total ceiling for the whole
// hold, armed at the first pause, because a per-pause ceiling would strand a
// child that never gets its marker for ceiling × operations. On expiry the
// barrier THROWS instead of continuing, so a hold that timed out can never be
// mistaken for a hold that was released: the child dies non-zero and the
// caller's exit-status assertion reds. Without RELEASE_ON_PATH nothing below
// changes.
let barrierStartedAt;
let barrierDeadline;
function holdUntilReleaseMarker() {
  if (barrierDeadline === undefined) {
    barrierStartedAt = Date.now();
    barrierDeadline = barrierStartedAt + pauseMs;
  }
  while (!markerExists(releaseOnPath)) {
    const remainingMs = barrierDeadline - Date.now();
    if (remainingMs <= 0) throw new Error(`REPLAYTEST durable-op barrier: release marker ${releaseOnPath} never appeared; gave up after ${Date.now() - barrierStartedAt} ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, remainingMs));
  }
}

let seen = 0;
const fdPaths = new Map();
function describe(args) {
  return args.map((value) => typeof value === 'number' && fdPaths.has(value) ? `${value}:${fdPaths.get(value)}` : String(value)).join(' | ');
}

for (const operation of operations) {
  const original = fs[operation];
  if (typeof original !== 'function') continue;
  fs[operation] = function durableOperationProbe(...args) {
    const beforeTarget = describe(args);
    const beforeBelongsToWorkspace = workspaceRoot === undefined || beforeTarget.includes(workspaceRoot);
    if (beforeBelongsToWorkspace && operation === pauseBeforeOp && pauseMs > 0 && (pauseMatch === '' || beforeTarget.includes(pauseMatch))) {
      if (tracePath !== undefined) writeTrace(tracePath, `${JSON.stringify({ operation, target: beforeTarget, phase: 'before' })}\n`, { encoding: 'utf8', flag: 'a' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
    }
    const result = original.apply(this, args);
    if (operation === 'openSync' && typeof result === 'number' && typeof args[0] === 'string') fdPaths.set(result, args[0]);
    const target = describe(args);
    const belongsToWorkspace = workspaceRoot === undefined || target.includes(workspaceRoot);
    // The retire-prefix battery predates the cross-verb state lease and is a
    // trace of retire's archive/journal protocol. Filter only private lock
    // publication paths, never a customer-state directory operation. Measured
    // with the lease: filter-off 216; lock-only filter 191; baseline before the lease 181.
    // Claim temps are named `..state-lock.claim-*` (double dot: the visible
    // lock's basename prefixed with another `.`), so the claim branch matches
    // an optional leading dot (a single-dot-only branch would never match).
    const privateStateLockTraffic = /(?:^|[\\/])\.?\.state-lock(?:\.claim-[^\\/|]+)?(?:$|[\\/|])/.test(target);
    if (tracePath !== undefined && belongsToWorkspace && !privateStateLockTraffic) writeTrace(tracePath, `${JSON.stringify({ operation, target })}\n`, { encoding: 'utf8', flag: 'a' });
    if (belongsToWorkspace && operation === killOp && (killMatch === '' || target.includes(killMatch))) {
      seen += 1;
      if (seen === killAt) {
        process.stderr.write(`REPLAYTEST SIGKILL after ${operation}(${target})\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    }
    if (belongsToWorkspace && operation === pauseOp && pauseMs > 0) {
      if (!releaseOnPath?.trim()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
      else holdUntilReleaseMarker();
    }
    return result;
  };
}
syncBuiltinESMExports();
