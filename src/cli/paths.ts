import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Output paths — each encapsulated as a single module constant so
// moving either later (e.g. behind a future `--out-dir` flag) touches one
// line, not every call site. The plan path is a namespaced dot-folder for
// review artifacts that can't collide with an end-consumer's own top-level
// folders; the spec lives where Playwright already discovers it.
//
// PORTABLE ROOT: these anchor at the process CWD, not this module's directory
// — so an installed `replaytest` reads/writes THEIR repo (the cwd they run it
// from), never the tool's own install location under node_modules. In this
// repo's own dev flows (`npm run cli`), the cwd IS the repo root, so behavior
// is byte-identical to the previous module-relative form. The documented
// contract is "run `replaytest` from your repo root."
// ---------------------------------------------------------------------------

export const WORKSPACE_ROOT = process.cwd();
/** The installed package manifest, distinct from the customer's workspace manifest. */
export const PACKAGE_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
/** `.replaytest/plans/<slug>.md` + `.replaytest/plans/<slug>.plan.json` — `plan`'s review artifacts (the sidecar is the source of truth; the `.md` is a rendered projection of it). */
export const PLANS_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'plans');
/** `tests/generated/<slug>.spec.ts` — Playwright's existing spec home, so a scaffolded test is discovered/run with no extra config. */
export const GENERATED_TESTS_DIR = path.join(WORKSPACE_ROOT, 'tests', 'generated');
/** `tests/reproductions/<slug>.repro.spec.ts` — `repro`'s output home. The `repro-builder.ts` demo already writes examples there by convention; the distinct `.repro.spec.ts` suffix (vs `scaffold`'s `.spec.ts`) means a repro can never collide with a generated test even if a future change put both under one directory. */
export const REPRODUCTIONS_DIR = path.join(WORKSPACE_ROOT, 'tests', 'reproductions');
/** `.replaytest/frames/<slug>/` — derived local replay context for a coding agent. */
export const FRAMES_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'frames');
/** `.replaytest/cache/coarse-store/` — the sealed coarse-scan slices `gaps --stored` reads offline (must match `fetchCoarseSessions`'s live-write root). */
export const COARSE_STORE_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'cache', 'coarse-store');
/** `heal`'s default results-file input — a Playwright JSON-reporter run writes it via `PLAYWRIGHT_JSON_OUTPUT_NAME`. Override with `--results <path>`. */
export const DEFAULT_HEAL_RESULTS_PATH = path.join(WORKSPACE_ROOT, '.replaytest', 'last-run.json');
/** This workspace's last persisted heal envelope — selector repair reads its shown freshness evidence, never re-derives it. */
export const HEAL_LATEST_PATH = path.join(WORKSPACE_ROOT, '.replaytest', 'state', 'heal-latest.json');
/** Lightweight latest-result metadata: the dashboard uses it to spot a test run newer than a diagnosis. */
export const HEAL_LAST_RUN_STATE_PATH = path.join(WORKSPACE_ROOT, '.replaytest', 'state', 'last-run.json');
/** Standalone triage handoff; intentionally separate from the suite-wide heal envelope. */
export const TRIAGE_EVIDENCE_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'state', 'triage-latest');
/** Append-only local audit for the selector patches this workspace explicitly applied. */
export const SELECTOR_APPLIES_PATH = path.join(WORKSPACE_ROOT, '.replaytest', 'state', 'selector-applies.json');
/** Hash baselines for generated specs; separate from plan sidecars so scaffold cannot manufacture plan/spec drift. */
export const SPEC_EMITTED_HASHES_PATH = path.join(WORKSPACE_ROOT, '.replaytest', 'state', 'spec-emitted-hashes.json');
/** `.replaytest/retired/<slug>/` — the `retire` verb's archival home: `retirement.json` + every moved plan/spec/frames artifact. Git-tracked via the .gitignore re-include idiom (`!.replaytest/retired/`) so the record survives clones and shows in review diffs. */
export const RETIRED_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'retired');
/** `playwright/auth.setup.ts` — the one-time shared auth setup skeleton. */
export const AUTH_SETUP_PATH = path.join('playwright', 'auth.setup.ts');
/** `playwright/.auth/user.json` — the storage state written by the auth setup skeleton. */
export const AUTH_STORAGE_STATE_PATH = path.join('playwright', '.auth', 'user.json');
