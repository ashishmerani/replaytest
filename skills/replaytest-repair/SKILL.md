---
name: replaytest-repair
description: Repair a once-green replaytest-generated Playwright test when fresh traffic shows its plan or flow changed. Use when triage cannot create a matching proposal or a coding agent must preserve hand edits while applying a reviewed repair.
---

# Replaytest repair

Use this loop after a generated test has drifted. Run every command from the repo root of the app that holds the generated tests. `<slug>` is the plan's short name; it is also on the first line of each generated spec (`// replaytest-slug: <slug>`).

If `replaytest` is installed as a project dependency, prefix each replaytest command below with `npx` (for example, `npx replaytest triage <slug> --propose`).

The tool can find and write a review proposal; it never merges proposal content into the spec. You, the coding agent, make the final edit to the spec yourself. The consent flags in this loop are deliberate decisions: `--allow-cross-origin` and `--confirm-retire` (step 2) and `--confirm-different-journey` (step 5). Pass them only after reading the disclosure the tool prints.

## Auth-gated flows: fill the shared setup socket

When a persisted plan's auth witness, or the `login-redirect` finding from `preflight`, shows that the flow needs a signed-in browser context, run the guided setup command from your project's repo root:

```sh
replaytest auth-setup
```

What the command does:

- It reads the persisted `.replaytest/plans/*.plan.json` files and groups the plans that witnessed each `loginPath`.
- It writes one shared `playwright/auth.setup.ts` skeleton, but only when exactly one distinct login path was witnessed.
- It prints Playwright config wiring you can insert. It never edits the config and never stores credentials.
- It refuses to choose when several login paths were witnessed. Hand that grouped table to a coding agent that can read your project's repo.
- It does not list journeys before a witnessed login, or sessions with no witnessed login. Those may still be auth-gated; the recording simply did not witness it.

Then finish the skeleton:

- Open it and complete every `auth-socket:` marker (each marks a spot you must fill in).
- The recorded locators are evidence from the plan. Inspect the project's own repo to find the real credential source, sign-in flow, project dependencies, and `baseURL`.
- Use environment-variable references for credentials, and keep masked or witnessed values out of the file. Do not assume the project's folder structure or framework.
- Warning: if the setup runs before its sockets are filled, it can silently save an empty, unauthenticated `storageState`. Once the saved state expires, delete the skeleton, re-run `replaytest auth-setup`, then refill and verify the sign-in steps.

This is the auth-specific last step. It follows this skill's repair conventions: preserve hand edits, and verify the result in the target app before relying on the generated specs.

1. **Check hand edits first, before any tool rewrite.** Inspect the existing
   spec and its diff:

   ```sh
   git diff -- tests/generated/<slug>.spec.ts
   ```

   Keep intentional local changes. The emitted-spec hash record at
   `.replaytest/state/spec-emitted-hashes.json` can show whether the last
   tool-written baseline still matches; a mismatch is a hand-edit signal, not
   permission to overwrite the file.

2. Run the ordinary diagnosis first:

   ```sh
   replaytest triage <slug> --propose
   ```

   If its proposal path is a dead end (for example, the old signature is no
   longer present in fresh traffic), recover with:

   ```sh
   replaytest regenerate <slug>
   ```

   Regenerate searches only the configured app scope. Its Tier A result is a
   fresh same-signature journey. Its Tier B result is a different successor
   flow, ranked by how many leading steps of the route it shares with the
   original, and is explicitly
   disclosed as such. Review Tier B as a different journey; never treat it as a
   silent replacement.

   Two refusal codes to know:

   - `origin-unrecorded`: no site address could be resolved from the plan, its retained source
     session or the selected app scope. Select an app scope configured with one origin,
     re-plan from a retained source session, or use `--allow-cross-origin` only after
     confirming which site to consider.
   - `cross-origin-candidates`: fresh traffic crossed the property boundary or
     lacks a witnessed origin. Select the intended app scope, or pass
     `--allow-cross-origin` only after reviewing the other property.

   When regenerate also finds no candidates, the tool records an empty search
   on the plan's trail. Keep re-running it across the evidence window; once the
   evidence threshold is met (≥2 qualifying empty searches, ≥24h apart), the trail names the
   archival verb:

   ```sh
   replaytest retire <slug>
   ```

   `retire` presents the recorded evidence read-only first; pass
   `--confirm-retire` to archive the plan/spec/frames into
   `.replaytest/retired/<slug>/` with a reversal recipe. The tool never
   concludes the journey is absent — it records what fresh traffic showed in
   the window searched, and you make the call.

3. Read the proposal diff, including the spec pointer:

   ```sh
   replaytest diff <slug>
   git diff -- tests/generated/<slug>.spec.ts
   ```

   The rendering leads with a headline and then fixed sections — Assertions,
   Steps, Plan facts, Caveats, Bookkeeping — so what the test proves is first
   and the source IDs are one collapsed line last. A `⚠ Journey changed`
   marker on the headline's FIRST line means the proposal is backed by a
   different flow and will need `--confirm-different-journey` at accept time;
   the `Changed:` counts follow it. A `⚠ selector quality: … → guessed` line
   means the replacement locator is a positional/text guess worth checking by
   hand. Prefer `replaytest diff <slug> --json` when you want the same delta
   structurally: it emits the `SidecarDiff` object (`fields`, `steps`,
   `assertions`, `summary`) instead of Markdown, so you can branch on
   `summary.journeyChanged` and per-step `quality` without parsing prose.

   `diff` re-derives from the two plan files and holds no traffic report, so
   for a changed locator it shows the plan's own selector quality (where the plan records one and the confidence actually moved, the new locator is a guess, or it carries warnings) but not what
   fresh traffic recommends. That evidence lives only in the
   `.proposed.diff.md` written by the `triage --propose` / `heal --propose`
   run that collected it. `diff` prints a trailing note (and sets `note` in
   `--json`) whenever that applies, naming the file to read.

   The proposal slot is shared with triage and heal, so resolve or deliberately
   discard an existing proposal before regenerating again.

4. Apply the reviewed delta to `tests/generated/<slug>.spec.ts` yourself.
   Preserve intentional hand edits and make the smallest change that expresses
   the reviewed journey. What to do depends on the spec:

   - No hand edits and the slug is undeclared: `replaytest scaffold <slug> --force`
     is the right next step. Re-scaffold only when overwriting the spec is
     intended.
   - The slug is declared hand-finished: you get a notice instead. Remove that
     declaration before any deliberate re-scaffold.
   - The spec has hand edits: apply the reviewed delta yourself instead.
     While this accepted plan still matches, `heal`, `suite-status` and
     `preflight` report `accepted-unverified`, because replaytest cannot prove
     the hand edit. A later plan change becomes `unverified`; an untouched
     machine spec can be confidently `drifted`.

   If the hand-finished registry is broken, commands stop instead of guessing.
   Malformed JSON, a top level that is not an array, or an entry that is
   invalid, duplicated or missing an audit field makes `suite-status`, `heal`,
   `preflight`, `triage`, `accept`, and `fix-selector` refuse to run until you
   repair `.replaytest/hand-finished.json`. A declared slug that has neither a plan nor a spec blocks nothing, and no
   command reports it: commands that work through your plans simply skip it.
   Remove the declaration, or restore the missing plan and spec.

5. Verify the repaired spec in the target environment, then promote the plan:

   ```sh
   replaytest accept <slug> --force
   ```

   For a Tier B successor-flow proposal, consent is explicit and limited to that
   path. This is a deliberate decision, because it swaps the recording the test
   was built from, so pass it only after reading the disclosure the tool prints:

   ```sh
   replaytest accept <slug> --force --confirm-different-journey
   ```

   Acceptance refreshes the tool's saved fingerprints and records the promotion,
   without erasing an existing hand-edit signal. You remain responsible for the
   spec delta and its verification.
