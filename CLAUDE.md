# CLAUDE.md

Guidance for AI coding agents working in this repository.

## What this is

A pipeline that turns real production user sessions from PostHog into maintained Playwright regression tests. PostHog is the only supported provider; the session-to-plan pipeline reads it through one adapter. The pipeline is: provider session → normalized events (`NeutralSession`) → journeys (grouped and ranked) → plain-English Markdown test plan (the review point, done by you or your coding agent) → Playwright test scaffold with witnessed-only (Tier-1) assertions. The `replaytest` CLI drives the whole loop, including maintenance: when a generated test breaks, `triage` and `heal` explain why from fresh traffic evidence and propose repairs for review and acceptance.

## Commands

```bash
npm test                # unit tests (no network, no live app)
npm run typecheck
npm run build
npm run cli -- --help   # the replaytest CLI from your working copy
npm run dashboard       # local dashboard at 127.0.0.1:4319 (reads and writes this repo, like the CLI)
npm run test:heal       # runs the generated specs and records results (needs the app under test at TARGET_APP_URL)
./node_modules/.bin/playwright test tests/generated   # needs the app under test at TARGET_APP_URL
```

The example specs and `test:heal` replay recordings of demo apps that are not public, so they are examples to read rather than tests a contributor can run.

Inside this repository, run tools through the npm scripts or `./node_modules/.bin/`, so every tool is the version pinned in `package-lock.json`.

## Where to look

- `docs/site/` contains the documentation site.
- `docs/AGENT-MAINTENANCE-GUIDE.md` describes the maintenance loop.
- `.replaytest/plans/` contains committed plan sidecars for generated specs.
- `archive/` contains the recorded-session corpus used by examples and evals.

## Rules

- Guard the provider seam: provider vocabulary belongs only in provider adapters; downstream code reads `NeutralSession`.
- Keep assertions at Tier 1: assert only facts witnessed by the session, never inferred outcomes or real masked values.
- Treat the app under test as a black box: the pipeline reads provider recordings, never the app's source.
- Do not hand-edit a generated spec merely to make it green; use the product’s repair and acceptance loop.
- Preserve privacy masking and use `***` for required synthetic masked-field values.

## Checks

Before proposing a change, run `npm test`, `npm run lint` and `npm run typecheck`, and add regression coverage for any behavior change. Pull requests are not open yet; see `CONTRIBUTING.md`.
