# CLI reference

Every `replaytest` command and its options. The `--help` text in the boxed blocks on this page is generated from the CLI itself, so it matches what is installed. Run any of these with `npx replaytest <command>` (or `./node_modules/.bin/replaytest <command>`) from your repo root.

Of the 24 CLI verbs, 19 work without caveats and 3 more work with caveats. The 3 with caveats are `regenerate`, `heal` and `accept`. The other 2, `fix-selector` and `auth-setup`, are not counted: they act only on a test with a broken selector or on recordings that include a login.

## Full command list

This is the exact output of `replaytest --help` (or `replaytest help`, or running `replaytest` with no arguments):

<!-- fixture:cli-help -->
```text
replaytest — turn real PostHog sessions into Playwright regression tests

Usage:
  replaytest init [--project <id>] [--token <key>] [--host <host>]
      Configure PostHog access (writes the repo-root .env), and ensure .env plus
      .replaytest/ are gitignored: create a minimal .gitignore or append missing entries.
      --host defaults to us.posthog.com; set it for EU Cloud (eu.posthog.com) or a self-hosted domain.
  replaytest version | --version | -v
      Print the installed replaytest package version.
  replaytest sessions [<sessionId> --from-archive <dir>] [--app <name>] [--completed] [--navigated] [--submitted] [--with-exceptions] [--shape <name>] [--families] [--gaps-only] [--stored] [--exact] [--json] [--replay-availability] [--fresh] [--since-hours N] [--limit N] [--all] [--page-size N] [--max-pages N] [--refresh-top N] [--steal-scan-lock] [--watch [--interval 15m|1h] [--max-ticks N]]
      List ranked canonical journeys from recent sessions (default last 720h (30 days); override with --since-hours N).
      --with-exceptions filters to journeys whose session's events witnessed a JS
      exception (exact scan only — coarse mode prints an honest one-liner and exits 0
      with no rows rather than pretending).
      --shape is repeatable and AND-composed: form-submit-signal, deep-wizard, rage-clicks. Shape-filtered
      output labels Seen directly, Strong hint, or Couldn't check; unavailable evidence is reported, never treated as no match.
      Wizard URL overrides: add {"wizardStepParams":["step","phase"]} to
      .replaytest/config.json. Names are case-insensitive; only ordinal values 1–99 match.
      App scope: declare {"apps":{"shop":["https://shop.example"]},"app":"shop"} in
      .replaytest/config.json, or use --app <name> to select a declared app for this scan.
      --families: Families group paths that are segments of one longer recorded route (structural, not goal-based). Plans/tests stay per exact path. Path-based grouping for path-changing flows.
      --gaps-only hides only exact rows whose lifecycle is Passing; coarse rows always stay visible.
      --stored reads the dashboard's one stored snapshot without contacting PostHog; it refuses incompatible filters and names the stored key.
      --exact is slower — it reads every session's events and bypasses the automatic coarse-scan switch. A forced --exact first states its whole-project session count (not a guessed duration). At the structural page ceiling it returns the exact rows read so far and names the covered sessions, pages, and window.
      Coarse scans print an expected-case history estimate before work, report completed UTC days of history, name an up-to-date cache, and label every result with its scan mode.
      --replay-availability adds a bounded live check to JSON replay links; unavailable can mean capture was off or the replay expired, while unknown is never absence.
      --watch polls PostHog for new sessions on a cadence, printing one line per check and updating the same snapshot the dashboard reads (the next dashboard start picks it up for free; a dashboard already running keeps its in-memory view until restarted).
      Defaults to the saved auto-check interval (15m/1h); --interval 15m|1h overrides it (15m is the floor). --max-ticks N runs a bounded number of checks. Foreground only — stopping the process (Ctrl-C) stops the checks. Cannot combine with --json or --stored.
  replaytest gaps [--app <name>] [--shape <name>]... [--refresh-sample] [--sample-size N] [--json] [--fresh] [--stored] [--exact] [--since-hours N] [--limit N] [--all] [--steal-scan-lock]
      Read the core traffic-signal link map. It ranks only rows with no known link in
      this inventory; possible existing-suite matches and unavailable evidence stay in separate lanes.
      --refresh-sample precomputes newest-session observations (default 50; max 1000) without changing the core map. With --app it checks newest project sessions first, up to the fixed 250-candidate ceiling and the sample time budget, then reports the actual checked count.
      --exact is slower — it reads every session's events and bypasses the automatic coarse-scan switch. A forced --exact first states its whole-project session count (not a guessed duration). At the structural page ceiling it returns the exact rows read so far and names the covered sessions, pages, and window.
      Coarse scans print an expected-case history estimate before work, report completed UTC days of history, name an up-to-date cache, and label every result with its scan mode.
      --stored recomputes the map offline from the sealed coarse-store slices a prior live scan persisted — never contacts PostHog. It refuses (does not fall back to a live scan) when no stored scan covers this workspace, and loudly labels a partially-sealed snapshot. Cannot combine with --exact, --fresh, or --refresh-sample.
  replaytest scan-status [--json]
      Reports your saved scan history. Makes no PostHog calls and starts no scan.
      Reads manifest metadata plus local project configuration only; it never opens saved session rows.
      Shows stored settled UTC-day coverage, first reads awaiting a second count-matching read,
      and any recorded capped/interrupted gaps. The default view is 30 days; your scans may use
      a different --since-hours window. --json keeps bounded ranges and gaps structured.
  replaytest plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-cross-origin] [--allow-privacy-disclosure] [--steal-scan-lock]
      Fetch a session and write a reviewable sidecar (<slug>.md + <slug>.plan.json)
      to .replaytest/plans/ for each plannable journey. Refuses to overwrite a
      sidecar owned by a different or unknown journey unless --force is passed.
      Plannable = every completed journey, plus a navigated one holding a single
      inline-commit create (its spec presses the committing keystroke as a step
      marked SYNTHESIZED, because no recording captures it).
      Refuses a journey that spans origins or that witnessed no origin at all,
      so a plan never asserts one property's URLs against another's — and
      holds back every other plannable journey in the same session too, since
      plan writes a session's journeys as one batch. Pass --allow-cross-origin
      only after reviewing the other property, to release the whole run.
      Samples up to 8 matching sessions by default for assertion evidence;
      pass --sample 0 to disable, or --sample N (max 20) to tune it.
      Archive mode: replaytest plan <sessionId> --from-archive <dir>
  replaytest scaffold <slug> [--force] [--out <path>] [--steal-state-lock]
      Generate tests/generated/<slug>.spec.ts (and re-render <slug>.md) from an
      already-written sidecar. Refuses to overwrite an existing spec: pass --force
      to overwrite it, or --out <path> to write a new file you diff yourself.
  replaytest frames <slug> [--from-archive <dir>] [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]
      Create local per-step replay DOM and screenshots for a coding agent. Frames
      contain real historical user content: keep them local and never commit/share them.
  replaytest repro <distinctId> [--session <sessionId>] [--out <path>] [--force]
      Emit a Tier-0 reproduction spec (tests/reproductions/<slug>.repro.spec.ts) for
      EVERY journey in the session, any status (error/abandoned included) — re-driving
      the recorded steps IS the smoke; no assertions are active. Notes witnessed
      exceptions in a header comment. Refuses to overwrite an existing file unless
      --force; --out <path> writes elsewhere (single-journey sessions only).
  replaytest preflight <slug> [--json]
      Check the LOCAL plan's recorded locators against the LIVE APP at TARGET_APP_URL
      (default http://localhost:8000; warns when that fallback is used). Never calls
      PostHog or runs the full spec: reports resolves, DEAD, gated-unreachable after a
      recorded submit, or couldn't check when direct goto cannot reach a page.
      Exits 1 when it finds dead selectors or verifies no selectors; otherwise each row states
      what was checked.
      Triage fresh traffic to learn what a dead locator became — preflight complements,
      never replaces, triage.
  replaytest triage <slug> [--sample N] [--since-hours N] [--app <name>] [--propose] [--force] [--json] [--steal-state-lock] [--steal-scan-lock] [--reuse-evidence [--max-age <duration>]]
      Explain why a generated test may now be failing by checking fresh traffic for
      the sidecar signature. Never changes your journey definition; healthy live checks
      record only their own evidence trail in the plan sidecar (disclosed on the first write).
      Proposals go only to .replaytest/plans/<slug>.proposed.plan.json + <slug>.proposed.md.
      --app <name> confines the evidence to one app declared in .replaytest/config.json,
      so a verdict is never derived from another site's traffic; sessions set aside are
      disclosed, never silently dropped.
  replaytest regenerate <slug> [--since-hours N] [--app <name>] [--allow-cross-origin] [--json] [--steal-scan-lock]
      Re-source a stale plan from fresh traffic into the existing proposal slot. It tries
      the same journey first, then a disclosed successor flow; review diff and apply the
      spec delta yourself — replaytest never merges a generated spec. Refuses candidates
      from another origin, spanning origins, or lacking a witnessed origin unless --allow-cross-origin is reviewed.
      When it finds no candidate, its empty live search records only an evidence trail in the plan
      sidecar (disclosed on the first write), never your journey definition.
  replaytest diff <slug> [--json]
      Re-render the proposed plan sidecar against the current live plan without changing either file.
      --json emits the same structured change object the propose/regenerate envelopes carry,
      so a coding agent reads the delta without parsing the rendered Markdown.
  replaytest doctor [--since-hours N] [--json] [--steal-scan-lock]
      Read-only provider-capability preflight: 7 independent probes report what
      this project can feed plan/scaffold (events flowing, autocapture richness,
      recordings, Tier-3 replay DOM) plus your local Playwright/posthog-cli
      version fit, and what degrades if a probe is weak. Never writes to PostHog;
      maintains a local cache under .replaytest/cache/ and exits 0 whenever PostHog is configured.
  replaytest heal [--results <path>] [--since-hours N] [--sample N] [--app <name>] [--propose] [--force] [--allow-stale] [--json] [--steal-state-lock] [--steal-scan-lock]
      Batch-triage every genuinely-failed spec from a Playwright JSON-reporter run
      (default .replaytest/last-run.json — produce it with this Playwright command:
      `PLAYWRIGHT_JSON_OUTPUT_NAME=.replaytest/last-run.json ./node_modules/.bin/playwright test tests/generated --reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`, then
      run 'replaytest heal' as a separate step). Classifies failure MODE first —
      flaky/timed-out/interrupted/environment-network specs get no traffic verdict —
      maps each real
      failure back to its plan (a slug header, else the tests/generated/ path
      convention), then runs the same evidence-based check as `triage` for each one,
      sharing ONE traffic scan across the whole batch. A verdict that looks clean on
      a spec Playwright actually failed is flagged, never hidden. --propose writes
      flow-changed proposals + a rendered plan-diff, same as `triage --propose`. Runs older
      than 6 days require --allow-stale; re-run the Playwright command above for current evidence.
      --app <name> confines every slug's evidence to one app declared in
      .replaytest/config.json; the batch still shares ONE traffic scan.
  replaytest accept <slug> [--force] [--confirm-different-journey] [--json] [--steal-state-lock]
      Promote .replaytest/plans/<slug>.proposed.plan.json to the live
      <slug>.plan.json, refresh <slug>.md from that JSON, and retire the
      consumed proposal artifacts. Refuses an existing live plan unless --force.
      A different journey needs --confirm-different-journey too; a same-signature
      regenerate proposal is treated as the same journey, so --force alone promotes it.
      Does not re-scaffold; on success prints the next command: replaytest scaffold <slug> --force.
  replaytest retire <slug> [--confirm-retire] [--no-evidence] [--steal-lock] [--steal-state-lock] [--recover-crashed-locks] [--allow-privacy-disclosure] [--json]
      Review the accumulated empty-search evidence for a journey and, once the
      evidence bar is met, archive its plan/spec/frames/default-path repro into
      .replaytest/retired/<slug>/ with a reversal recipe. Read-only by default:
      no flag presents the trail, the bar status, successor observations, and the
      consent command. --confirm-retire performs the archival (bar must be met).
      --confirm-retire --no-evidence retires below the bar on operator assertion
      (the tool records the assertion, never adopts it). Each flag alone refuses.
      Keep the archive folder local to preserve the record; see retirement.json to reverse.
      An interrupted retirement resumes only with --confirm-retire. After a crash,
      --recover-crashed-locks performs the combined recovery only when BOTH lock owners
      are dead. Use either --recover-crashed-locks or the explicit steal flags, not both.
      Granular form: --confirm-retire --steal-lock --steal-state-lock.
      All shared state writers serialize through one cross-verb state lock; --steal-state-lock
      may allow one live holder write to land over recent state. Retire still acquires
      its retire lock first, then the shared state lock; the reverse order is forbidden.
  replaytest suite-status [--since-hours N] [--app <name>] [--json]
      Reverse pass over every plan: is each one's journey still present in recent
      traffic at all? Flags DEAD coverage (no matching traffic — never phrased as
      "delete this test", traffic can be seasonal) separately from UNRESOLVABLE
      plans (no recorded signature — never counted as dead) and from plans that are
      not yet scaffolded. Read-only; shares one traffic scan across every plan.
      --app <name> counts coverage only inside one app declared in .replaytest/config.json,
      so another site's traffic can neither create nor hide a dead-coverage finding.
      Differs from suite-health: this is plan-inventory freshness; suite-health diagnoses last test runs plus coverage per generated spec.
  replaytest suite-health [--app <name>] [--json]
      Join local generated specs, plans, and the last heal run with a fresh shared
      suite-status coverage scan. Shows recorded evidence only: an empty workspace or
      absent heal run is never inferred to be green.
      --app <name> is passed straight through to that shared coverage pass.
      Differs from suite-status: this is per-generated-spec health; suite-status is the plan-inventory freshness reverse check.
  replaytest reconcile [--apply] [--dry-run]
      Report sidecars superseded by a newer plan batch for the same recorded session.
      Default and --dry-run only report; --apply renames sidecars to .superseded.*.
  replaytest fix-selector <slug> [--apply] [--dry-run] [--occurrence N] [--prefer stability|fidelity] [--from-triage-verdict] [--allow-privacy-disclosure] [--json] [--steal-state-lock]
      Show the newest persisted triage or heal selector patch by default. --apply replaces
      exactly one emitted occurrence; when several match, choose one with --occurrence N.
      --from-triage-verdict tolerates a prior hand-edit: it applies the diagnosed verdict
      even when the old locator string is gone, and reports "already applied" if the spec
      already holds the fresh locator (never overwrites a hand-edit silently).
      --prefer fidelity is the default; --prefer stability selects a recorded alternate
      only when the latest fresh traffic also verified it.
  replaytest auth-setup [--allow-privacy-disclosure]
      Read persisted plan sidecars that witnessed a login, write one shared
      playwright/auth.setup.ts skeleton, and print an insertable config snippet.
      It never edits your Playwright config, never stores credentials, and refuses
      to overwrite an existing auth.setup.ts. The v1 interface is human-readable;
      --json is intentionally not supported.
  replaytest dashboard
      Start the local dashboard (a browser GUI over these same commands) on
      http://127.0.0.1:4319 — override the port with PORT. Reads/writes the repo
      you run it from, same as every other command.
  replaytest explain [<refusal-code>] [--list] [--full] [--json]
      Explain a known refusal code without reading workspace data or contacting PostHog.
      Re-run the command that refused with --json and use error.code,
      then run replaytest explain <verb.code>. For example, a regenerate.origin-unrecorded
      refusal means no site address could be resolved; use --list to discover codes.
      The message field is the exact refusal message template; {{…}} marks parts filled in
      when the command runs — with a value, a context-dependent phrase, or nothing at all.
      --list prints a compact grouped list; --full requires --list and includes each entry's detail.
  replaytest help
      Show this message.

Completion evidence ladder
- Completed: A form submit followed by a navigation to a distinct witnessed URL.
  Conditions: A submit step is followed later by a navigation. The final URL differs from the entry URL after only index-file and trailing-slash spelling are normalized.
  Known false-positive shapes: A submit can still be an application-side failure; this records the witnessed route change, not backend validation.
- Navigated: Typed input followed by a landing on a new route; no form submit was witnessed.
  Conditions: No submit step exists; at least one input step exists. The last landing is new by exact URL and canonical path, and input occurred away from that landing. Trailing interactions are trimmed to retain the landing witness.
  Known false-positive shapes: Search-then-open: typed a query and opened an existing result. Typed-then-bailed-elsewhere: changed a field, then navigated away for another reason. Created-then-deleted: later delete activity is trimmed after the landing.
- Submitted: A form submit, without a distinct post-submit landing.
  Conditions: At least one submit step exists. The completed submit-then-navigation rule did not hold.
  Known false-positive shapes: The submit may have succeeded in place or its landing may have been missing from the recording.
- Abandoned: No form submit was seen, and we didn't see typing followed by arriving on a new page.
  Conditions: No completed, navigated, or submitted rule matched.
  Known false-positive shapes: A missing captured event can make an otherwise successful flow appear abandoned.
- Note: The quick scan reads summary numbers only — it never opens the full recording, so it can't spot Navigated journeys. Quick-scan counts may show fewer Navigated (and more Abandoned) than a full scan finds.
- Note: Navigated counts are a minimum, not a total. When one session creates several records back to back, those creates can merge into a single journey and be counted once. Splitting them apart is not built yet, so a low Navigated count is never on its own evidence that this class is rare.

First touch: `replaytest init` → `replaytest sessions` → `replaytest plan <distinctId>` → `replaytest scaffold <slug>` → run the generated test. Use `replaytest doctor` only when something is wrong; use `replaytest preflight <slug>` before a real run. Neither is a first-touch step. For a red test, read AGENT-MAINTENANCE-GUIDE.md (shipped with replaytest).
```
<!-- /fixture -->

## `init`

`init [--project <id>] [--token <key>] [--host <host>]` — configures PostHog access, writing the credentials to your repo-root `.env` and ensuring both `.env` and `.replaytest/` are gitignored. It creates a minimal `.gitignore` if your repo has none; if an existing `.gitignore` lacks either entry, it appends the missing entry. `--host` defaults to `us.posthog.com`; set it for EU Cloud (`eu.posthog.com`) or a self-hosted domain. Run with no flags to see your current configured status instead of changing anything.

<!-- fixture:cli-help-init -->
```text
Usage:
  replaytest init [--project <id>] [--token <key>] [--host <host>]
      Configure PostHog access (writes the repo-root .env), and ensure .env plus
      .replaytest/ are gitignored: create a minimal .gitignore or append missing entries.
      --host defaults to us.posthog.com; set it for EU Cloud (eu.posthog.com) or a self-hosted domain.
```
<!-- /fixture -->

## `version`

`version` (also `--version` or `-v`) prints the installed `replaytest` package version.

<!-- fixture:cli-help-version -->
```text
Usage:
  replaytest version | --version | -v
      Print the installed replaytest package version.
```
<!-- /fixture -->

## `doctor`

`doctor [--since-hours N] [--json]` — checks what your PostHog project can provide, without changing anything in it. It runs seven separate checks, called probes. They report whether events are flowing, how much detail autocapture records, and whether session recordings and the replay DOM snapshots (Tier-3) are available. They also check that your local `@playwright/test` and `posthog-cli` versions are ones this tool has been tested with. For each weak result, `doctor` says what your plans will lose. For example, with no replay DOM the selectors are weaker, and the plan labels them that way. `doctor` never writes to PostHog. It keeps a local cache under `.replaytest/cache/`, and it exits 0 whenever PostHog is configured.

`REPLAYTEST_DOCTOR_BUDGET_MS` sets doctor's overall time limit, in milliseconds (default `180000`). The limit is checked only **between** probes that call PostHog, so it cannot interrupt one that is already running. It is therefore not a strict cap on total run time. In the worst case, doctor runs for the limit plus one more probe.

Each PostHog command inside a probe is limited by `REPLAYTEST_POSTHOG_TIMEOUT_MS` (default `120000`) and is retried up to twice, only after temporary failures. Probe 3 reuses probe 2's count query, and its coarse store (the local saved copy of session summaries) gets whatever overall time remains. To lower that one probe's cap, set `REPLAYTEST_DOCTOR_COARSE_BUDGET_MS`.

When the limit runs out, doctor reports every remaining PostHog probe as skipped (it never leaves one out silently) and still runs its local configuration and version probes. To run the skipped probes, raise `REPLAYTEST_DOCTOR_BUDGET_MS` or narrow `--since-hours`. If the coarse store reaches its cap, do one of these: narrow `--since-hours`, raise `REPLAYTEST_DOCTOR_COARSE_BUDGET_MS`, or run `doctor` again at least 10 minutes later. When two reads agree, that stretch of history is settled (saved), so later runs do less work.

<!-- fixture:cli-help-doctor -->
```text
Usage:
  replaytest doctor [--since-hours N] [--json] [--steal-scan-lock]
      Read-only provider-capability preflight: 7 independent probes report what
      this project can feed plan/scaffold (events flowing, autocapture richness,
      recordings, Tier-3 replay DOM) plus your local Playwright/posthog-cli
      version fit, and what degrades if a probe is weak. Never writes to PostHog;
      maintains a local cache under .replaytest/cache/ and exits 0 whenever PostHog is configured.
```
<!-- /fixture -->

## `explain`

`explain [<refusal-code>] [--list] [--full] [--json]` reads the local refusal catalog only: it never reads workspace state or contacts PostHog. Re-run a refusing command with `--json`, take its `error.code`, and pass the full `<command>.<code>` name to `replaytest explain <verb.code>`. For example, `regenerate.origin-unrecorded` means no site address could be resolved from the plan, its retained source session or the selected app scope. Select an app scope configured with one origin, re-plan from a retained source session, or use `--allow-cross-origin` only after confirming which site to consider. A code given without its command prefix resolves only when exactly one command uses it; otherwise `explain` lists the full names to choose from instead of guessing. `--list` prints the compact grouped catalog; `--full` adds each entry's detail and works only together with `--list`. The `message` field is the exact refusal message template; `{{…}}` marks parts filled in when the command runs — with a value, a context-dependent phrase, or nothing at all.

When the arguments are invalid, `explain --json` returns the plain usage-error object `{ error: { code, message } }`, with no `schemaVersion` or `kind` (the same format other commands use for usage errors); the resolved, list, unknown-code, and ambiguous-code forms remain versioned at `schemaVersion: 1`. Each resolved `cases[]` entry carries `{ description, message, exitCode }`, where `exitCode` is the integer exit code for that situation. In a resolved entry, `tier` says in plain words whether the code is shown in command output, and `override` is either an object or `null`. A field that is absent is not the same as `null`.

<!-- fixture:cli-help-explain -->
```text
Usage:
  replaytest explain [<refusal-code>] [--list] [--full] [--json]
      Explain a known refusal code without reading workspace data or contacting PostHog.
      Re-run the command that refused with --json and use error.code,
      then run replaytest explain <verb.code>. For example, a regenerate.origin-unrecorded
      refusal means no site address could be resolved; use --list to discover codes.
      The message field is the exact refusal message template; {{…}} marks parts filled in
      when the command runs — with a value, a context-dependent phrase, or nothing at all.
      --list prints a compact grouped list; --full requires --list and includes each entry's detail.
```
<!-- /fixture -->

Commands that write shared state files take turns through one shared write lock (`.replaytest/state/.state-lock`), so two commands never write those files at once. Only an explicit `--steal-state-lock` can take the lock from a command that still holds it; ordinary commands never push one another out. A failure while syncing a state directory to disk is not reported. If another command took the lock over while this one was finishing, a `state-lock-released-late` warning names the shared state files this command saved through the state writer; it makes no claim about plans, test files, archives or other files the command changed.

## `sessions`

In `--json` output, each journey carries `lifecycle` (`planned`, `scaffolded`, `executed`, or `passing`) and `evidenceBasis`. When they apply, each journey also carries `reason`, `recordedAt`, and `stale`. The `planned` and `tested` fields are also present: `planned` means a plan exists, and `tested` means the generated test file exists (the `scaffolded` stage). A journey counts as `passing` only when a test run saw a pass that was not flaky, the test file's content hash matches the hash recorded for that run, and the evidence is not stale. `--gaps-only` hides only exact `passing` rows; coarse (quick-scan) rows remain visible.

`sessions [--app <name>] [--completed] [--navigated] [--submitted] [--with-exceptions] [--shape <name>] [--families] [--gaps-only] [--stored] [--exact] [--json] [--replay-availability] [--fresh] [--since-hours N] [--limit N] [--all] [--page-size N] [--max-pages N] [--refresh-top N]` — lists the journeys in your recent traffic, ranked by how often each one happens (the last 720h / 30 days by default). To limit a scan to one app, declare named apps and their URL prefixes in `.replaytest/config.json`, for example `{"apps":{"shop":["https://shop.example"]},"app":"shop"}`. `--app <name>` picks a different declared app for one run.

A scoped result also reports how many sessions had no matching page URL, and how many sessions belonged to other apps and were left out. Prefixes do not match subdomains, so declare `https://staging.shop.example` separately from `https://shop.example`. With no scope set, a scan that spans several origins names them and suggests declaring an app. If all traffic comes from one origin, it says nothing.

When the rows on screen come from more than one site, the table adds a `sites` column just before the `signature` column (the page paths of the journey), also in `--families`. It shows each row's sites without the scheme, cut off at 24 characters, so a cut-off cell can make two long site names look the same. The full list is always in `--json` under `witnessedOrigins`. A row is a total across sessions, so if its sessions crossed sites, it lists both sites instead of being split up or assigned to one. A row whose sessions saw no page URL is left blank rather than guessed. If every row comes from one site, the output is unchanged: no column and no extra JSON field.

A scoped scan can still show the column when one retained session's journey itself crossed sites. That is correct output, not a scoping failure.

`--navigated` works only with an exact scan. It keeps journeys where someone typed input and then landed on a new page, with no form submit seen. The quick (coarse) scan reads summary numbers only, so it cannot spot these journeys. `--with-exceptions` keeps journeys whose session recorded a JavaScript error (exact scan only; in quick-scan mode it says so rather than pretending).

`--shape` can be repeated, and every shape you give must match (`form-submit-signal`, `deep-wizard`, `rage-clicks`). Each result is labelled "seen directly," "strong hint," or "couldn't check"; evidence that is unavailable is never treated as "no match."

`--families` merges journeys that are parts of one longer recorded route into one ranked row, to make the list easier to read. Plans and generated tests still use the exact path. `--gaps-only` uses the same rule as the dashboard: it hides only rows that are exact and whose lifecycle is Passing; coarse rows stay visible.

The printed table shows at most 200 data rows by default; `--all` shows every row. `--limit N` shows at most N journeys (or N top-level family rows with `--families`), after every filter you asked for. It does not make the scan cheaper, so use `--since-hours N` to narrow the traffic window. The default 200-row cap never changes `--json` output; an explicit `--limit` still limits its top-level entries.

`--exact` skips the automatic switch to a quick (coarse) scan. It is slower, because it reads every session's events. If it reaches the built-in limit on pages read, it returns the exact rows read so far and says which sessions, pages and time window they cover.

`--stored` on its own shows the latest dashboard snapshot for this project, even if that snapshot was saved with different options (for example `--families`, a limit or `--since-hours`). Any stored filters you ask for explicitly must match. App scope must always match exactly: a snapshot saved for one app is refused by a read with no app or a different app, and a snapshot saved with no app is refused by a read that names one. `--stored` never contacts PostHog, and it refuses `--exact` and other flags that need a live scan.

`--replay-availability` adds a quick, limited live check to the replay links in `--json` output.

`--watch` is the no-browser version of the dashboard's auto-check. On a schedule (the saved 15m/1h interval, or `--interval 15m|1h`; 15m is the shortest allowed), it polls PostHog for new sessions, runs the same new-session check as the dashboard each time, updates the same on-disk snapshot the dashboard reads, and prints one line per check. It runs in the foreground until you stop it (Ctrl-C) or `--max-ticks N` checks are done. It cannot be combined with `--json` or `--stored`.

<!-- fixture:cli-help-sessions -->
```text
Usage:
  replaytest sessions [<sessionId> --from-archive <dir>] [--app <name>] [--completed] [--navigated] [--submitted] [--with-exceptions] [--shape <name>] [--families] [--gaps-only] [--stored] [--exact] [--json] [--replay-availability] [--fresh] [--since-hours N] [--limit N] [--all] [--page-size N] [--max-pages N] [--refresh-top N] [--steal-scan-lock] [--watch [--interval 15m|1h] [--max-ticks N]]
      List ranked canonical journeys from recent sessions (default last 720h (30 days); override with --since-hours N).
      --with-exceptions filters to journeys whose session's events witnessed a JS
      exception (exact scan only — coarse mode prints an honest one-liner and exits 0
      with no rows rather than pretending).
      --shape is repeatable and AND-composed: form-submit-signal, deep-wizard, rage-clicks. Shape-filtered
      output labels Seen directly, Strong hint, or Couldn't check; unavailable evidence is reported, never treated as no match.
      Wizard URL overrides: add {"wizardStepParams":["step","phase"]} to
      .replaytest/config.json. Names are case-insensitive; only ordinal values 1–99 match.
      App scope: declare {"apps":{"shop":["https://shop.example"]},"app":"shop"} in
      .replaytest/config.json, or use --app <name> to select a declared app for this scan.
      --families: Families group paths that are segments of one longer recorded route (structural, not goal-based). Plans/tests stay per exact path. Path-based grouping for path-changing flows.
      --gaps-only hides only exact rows whose lifecycle is Passing; coarse rows always stay visible.
      --stored reads the dashboard's one stored snapshot without contacting PostHog; it refuses incompatible filters and names the stored key.
      --exact is slower — it reads every session's events and bypasses the automatic coarse-scan switch. A forced --exact first states its whole-project session count (not a guessed duration). At the structural page ceiling it returns the exact rows read so far and names the covered sessions, pages, and window.
      Coarse scans print an expected-case history estimate before work, report completed UTC days of history, name an up-to-date cache, and label every result with its scan mode.
      --replay-availability adds a bounded live check to JSON replay links; unavailable can mean capture was off or the replay expired, while unknown is never absence.
      --watch polls PostHog for new sessions on a cadence, printing one line per check and updating the same snapshot the dashboard reads (the next dashboard start picks it up for free; a dashboard already running keeps its in-memory view until restarted).
      Defaults to the saved auto-check interval (15m/1h); --interval 15m|1h overrides it (15m is the floor). --max-ticks N runs a bounded number of checks. Foreground only — stopping the process (Ctrl-C) stops the checks. Cannot combine with --json or --stored.
```
<!-- /fixture -->

## `plan`

`plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-privacy-disclosure]` — fetches a session and writes a plan you can review for each journey it can plan: every completed journey, plus a journey where the user typed into a field once and that took them to a new page (for example, creating a record inline). Each plan is `<slug>.md` plus its data file `<slug>.plan.json`, in `.replaytest/plans/`. It refuses to overwrite a plan it doesn't recognize unless you pass `--force`. By default it also samples up to 8 matching sessions, so the checks rest on evidence from several users rather than one (`--sample 0` turns this off; `--sample N`, up to 20, changes the number). Archive mode: `plan <sessionId> --from-archive <dir>` builds a plan entirely from a local session archive, with no call to PostHog.

To name a masked field, replaytest needs a saved copy of the page structure (a DOM snapshot) taken on the exact page where the field was used. If the recording moved on too fast, or the app changed page without a full reload (a single-page app route change), so that page was never snapshotted again, the plan uses generic wording instead. This depends on the recording, not on whether you fetched the session live or with `--from-archive`.

`plan --allow-privacy-disclosure` lets a value that looks like personal data (email, card or phone number, token) be written into a committed test file — for that one run only.

<!-- fixture:cli-help-plan -->
```text
Usage:
  replaytest plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-cross-origin] [--allow-privacy-disclosure] [--steal-scan-lock]
      Fetch a session and write a reviewable sidecar (<slug>.md + <slug>.plan.json)
      to .replaytest/plans/ for each plannable journey. Refuses to overwrite a
      sidecar owned by a different or unknown journey unless --force is passed.
      Plannable = every completed journey, plus a navigated one holding a single
      inline-commit create (its spec presses the committing keystroke as a step
      marked SYNTHESIZED, because no recording captures it).
      Refuses a journey that spans origins or that witnessed no origin at all,
      so a plan never asserts one property's URLs against another's — and
      holds back every other plannable journey in the same session too, since
      plan writes a session's journeys as one batch. Pass --allow-cross-origin
      only after reviewing the other property, to release the whole run.
      Samples up to 8 matching sessions by default for assertion evidence;
      pass --sample 0 to disable, or --sample N (max 20) to tune it.
      Archive mode: replaytest plan <sessionId> --from-archive <dir>
```
<!-- /fixture -->

Some commands check what they are about to write for values that look like personal data (an email address, a long card or phone number, a PostHog project token). `plan` checks route segments before it turns them into a slug. `auth-setup` and `fix-selector` check the values they are about to write: for `auth-setup`, the login steps that go into `playwright/auth.setup.ts`; for `fix-selector`, the old and new selector. `retire` checks whether its archive folder is covered by your Git ignore rules.

If a write is blocked because of its content, the error code is `privacy-disclosure-required`. Review the redacted findings, then repeat with `--allow-privacy-disclosure` for that one run only. If the retirement destination is not covered by Git ignore rules, `retire` refuses with `privacy-workspace-not-ignored` to protect local privacy state. Keep the archive folder local; pass the same flag only if you accept writing it outside Git's ignore rules.

The "best-effort warning" means a Git repository exists and says the destination is not covered by its ignore rules. `privacy-workspace-probe-skipped` means Git could not tell, so no safety claim is made.

## `auth-setup`

`auth-setup [--allow-privacy-disclosure]` — looks through the saved plan data files (`.replaytest/plans/*.plan.json`) for logins seen in the recordings, writes one login setup file, `playwright/auth.setup.ts`, and prints a config snippet for each case, ready to paste in. The file goes to pages by path only (`page.goto` with a path), reuses the login selectors from the recording, and leaves environment-variable placeholders where the login values go. It never edits your config or stores credentials. It also prints a table of which journeys need the login, and it lists journeys that start before a login was seen and sessions where no login was seen. If no login was seen, it writes nothing. If the recordings show more than one different login path, it refuses rather than guessing. If `playwright/auth.setup.ts` already exists, it refuses and tells you to delete it and run the command again. `--json` is not supported: the output is meant to be read by a person.

`auth-setup --allow-privacy-disclosure` lets a value that looks like personal data (email, card or phone number, token) be written into a committed test file — for that one run only.

<!-- fixture:cli-help-auth-setup -->
```text
Usage:
  replaytest auth-setup [--allow-privacy-disclosure]
      Read persisted plan sidecars that witnessed a login, write one shared
      playwright/auth.setup.ts skeleton, and print an insertable config snippet.
      It never edits your Playwright config, never stores credentials, and refuses
      to overwrite an existing auth.setup.ts. The v1 interface is human-readable;
      --json is intentionally not supported.
```
<!-- /fixture -->

## `scaffold`

`scaffold <slug> [--force] [--out <path>] [--steal-state-lock]` — generates the test scaffold `tests/generated/<slug>.spec.ts` (and re-renders `<slug>.md`) from the plan's data file, `<slug>.plan.json`, which `plan` wrote earlier. It refuses to overwrite an existing test file unless you pass `--force`; `--out <path>` writes a new file for your coding agent to compare instead. If scaffold finds the shared write lock held by another command, `--steal-state-lock` takes it over, for recovery only. If that command is still running, its one in-flight write may land over recent state.

<!-- fixture:cli-help-scaffold -->
```text
Usage:
  replaytest scaffold <slug> [--force] [--out <path>] [--steal-state-lock]
      Generate tests/generated/<slug>.spec.ts (and re-render <slug>.md) from an
      already-written sidecar. Refuses to overwrite an existing spec: pass --force
      to overwrite it, or --out <path> to write a new file you diff yourself.
```
<!-- /fixture -->

## `frames`

`frames <slug> [--from-archive <dir>] [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]` — saves, on your machine, a copy of the page structure (the DOM) and a screenshot for each step, for a coding agent to look at while it finishes a test scaffold. Frames contain real content from past users: keep them local, and never commit or share them.

<!-- fixture:cli-help-frames -->
```text
Usage:
  replaytest frames <slug> [--from-archive <dir>] [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]
      Create local per-step replay DOM and screenshots for a coding agent. Frames
      contain real historical user content: keep them local and never commit/share them.
```
<!-- /fixture -->

## `preflight`

`preflight <slug> [--json]` — a quick check, made against your running app, that the locators in a plan (the selectors that find each element) still find their elements. Run it before you run a generated test. It never calls PostHog or runs the full test. Its text output always starts by naming the base URL it checked: `TARGET_APP_URL` when set, otherwise `http://localhost:8000` with a warning that this fallback was used (also when `TARGET_APP_URL` was set but empty). Recorded paths are joined onto that base using normal URL rules, which can drop a path prefix, so every emitted `liveUrl` is the exact URL that was visited.

For each action, it opens the page recorded for that action at that URL and counts the elements that match the plan's locator. One or more matches counts as resolved (several matches are noted). Zero matches counts as **DEAD** only if the direct page visit returned HTTP 200 and no earlier step in the plan's data file is marked `isSubmit:true`. After an earlier recorded submit, the same zero count is reported as `gated-unreachable` instead. The earlier submit is identified by its recorded-action ordinal. Opening the page directly may not reach that state, so it could not be checked without interaction, and it is not evidence that the element is alive. Steps after a recorded submit are reported as gated, not DEAD; if an element was really removed there, it shows up when the full test runs.

A page that cannot be opened directly (a non-200 response, a navigation failure, or no recorded page for that action in the plan's data file) is reported as "couldn't check", never as dead.

`--json` reports the target URL in `targetAppUrl` and includes `verdict` (`passed`, `dead-selectors-found`, `partial`, or `inconclusive`), `baseUrl`, `baseUrlSource` (`env` or `default` for CLI runs; `option` is for programmatic or embedded use only and is never produced by the CLI), and `baseUrlFallbackReason` when the default was used. `summary.gatedUnreachable` counts gated rows, and each such step carries `gatedBehindStep`, the earlier submit's recorded-action ordinal.

To learn what a dead locator became, run `triage <slug>` with fresh traffic. Preflight complements triage and never replaces it.

The command exits **1** with `INCONCLUSIVE` when it verified no selectors. That means nothing was checked; it is not proof of a dead locator. A report with at least one directly checked selector is still diagnostic, and each row says exactly what was or was not checked.

`preflight` also exits **1** with `DEAD SELECTORS` when it directly checked and found one or more dead selectors. Its JSON `verdict` remains `dead-selectors-found`, so coding agents can branch on that machine-readable outcome while humans and CI use the non-zero exit.

`preflight` additionally reports **plan/spec drift**, in the same words as `heal` and `suite-status`. Drift means the plan and the generated test have moved apart. Preflight checks the locators recorded in the plan, so if the plan has changed since the test was generated, a green preflight does not describe the test you are about to run. The drift lines are:

- `plan/spec drift`, shown with confidence when the plan changed and the test file is still untouched machine output.
- `accepted but unverified` or `unverified`, when the test file carries hand edits that replaytest cannot verify.
- `plan/spec state: unknown`, when replaytest has no record of what it last generated for that test.

A slug declared in `.replaytest/hand-finished.json` gets the hand-finished disclosure instead. A declared slug that replaytest also has on record as a test it generated (in `.replaytest/state/spec-emitted-hashes.json`) gets a notice asking you to check which is true, and not to use `--force`. A declared test file that is missing while its plan remains is named stale. A declaration with neither a plan nor a spec is skipped by commands that work through your plans, and no command reports it; remove it when you no longer need it. Drift rows are informational and never change the exit code: the exit status stays the answer to "do the locators still resolve?". A report that already ends in `INCONCLUSIVE` or `DEAD SELECTORS` keeps its own instruction instead of also printing the generic no-baseline advice. A slug with no generated test prints no drift row at all, and a plan that could not be read or parsed is refused without any drift claim. `--json` carries the same `drift` state object those commands publish (`drift.verdict`, `drift.keying`, `drift.handEditStatus`, `drift.handFinishedDeclared?`, `drift.handFinishedStale?`, `drift.planIsReadable`) plus `hasSpec`, so even a hidden row can still be read by a program.

Preflight reports a separate `login-redirect` result for the first direct page load, but only when the final URL changed **and** one of these is true: (1) the plan's data file records a login (`sidecar.auth`) and the page it landed on has that login's recorded `loginPath`; or (2) the landed page contains `input[type=password]`. Case (2) does not need a recorded login; case (1) does. The finding only states what was observed and suggests `auth-setup` or `TARGET_APP_STORAGE_STATE`; it never claims the app requires authentication. For a `login-redirect` step the recorded locator is not checked. The step counts in `totalSelectors`, but is reported as neither resolved nor dead. A password field on the page you asked for, with no redirect, does not trigger this result. `--json` adds an optional top-level `authRedirect: { recordedAction, requestedPath, landedPath, matchesWitnessedLoginPath, passwordInputPresent }`.

The `.replaytest/hand-finished.json` file you commit (the list of tests finished after replaytest generated them, by your coding agent or by hand, that a re-scaffold must not overwrite) stops commands when it is broken. While it is broken, `suite-status`, `heal`, `preflight`, `triage`, `accept` and `fix-selector` refuse to run, until your coding agent repairs the file. Broken means invalid JSON, a top level that is not a list, or an entry that is invalid, duplicated or missing a required audit field. A declared slug that has neither a plan nor a spec blocks nothing, and no command reports it: commands that work through your plans simply skip it. Remove the declaration, or restore the missing plan and spec.

<!-- fixture:cli-help-preflight -->
```text
Usage:
  replaytest preflight <slug> [--json]
      Check the LOCAL plan's recorded locators against the LIVE APP at TARGET_APP_URL
      (default http://localhost:8000; warns when that fallback is used). Never calls
      PostHog or runs the full spec: reports resolves, DEAD, gated-unreachable after a
      recorded submit, or couldn't check when direct goto cannot reach a page.
      Exits 1 when it finds dead selectors or verifies no selectors; otherwise each row states
      what was checked.
      Triage fresh traffic to learn what a dead locator became — preflight complements,
      never replaces, triage.
```
<!-- /fixture -->

## `triage`

`triage <slug> [--sample N] [--since-hours N] [--propose] [--force] [--json] [--steal-state-lock] [--reuse-evidence [--max-age <duration>]]` — explains why a generated test may be failing, by comparing fresh traffic with the journey recorded in the plan's data file (its signature: the list of page paths). It never changes the journey definition unless you pass `--propose`. Healthy live checks save only their own evidence trail in the plan's data file, and the tool says so the first time it writes. Proposals go only to `.replaytest/plans/<slug>.proposed.plan.json` + `<slug>.proposed.md`. Where triage would otherwise suggest generating the test again, a slug listed in `.replaytest/hand-finished.json` gets the shared hand-finished notice instead. `--reuse-evidence` answers from a recent saved scan instead of a fresh one, and always shows how old that evidence is. If triage finds the shared write lock held by another command, `--steal-state-lock` takes it over, for recovery only. If that command is still running, its one in-flight write may land over recent state.

<!-- fixture:cli-help-triage -->
```text
Usage:
  replaytest triage <slug> [--sample N] [--since-hours N] [--app <name>] [--propose] [--force] [--json] [--steal-state-lock] [--steal-scan-lock] [--reuse-evidence [--max-age <duration>]]
      Explain why a generated test may now be failing by checking fresh traffic for
      the sidecar signature. Never changes your journey definition; healthy live checks
      record only their own evidence trail in the plan sidecar (disclosed on the first write).
      Proposals go only to .replaytest/plans/<slug>.proposed.plan.json + <slug>.proposed.md.
      --app <name> confines the evidence to one app declared in .replaytest/config.json,
      so a verdict is never derived from another site's traffic; sessions set aside are
      disclosed, never silently dropped.
```
<!-- /fixture -->

## `regenerate`

`regenerate <slug> [--since-hours N] [--app <name>] [--allow-cross-origin] [--json]` — rebuilds a stale plan from fresh traffic and saves it in the existing `.proposed.*` review slot. **Tier A:** it first looks for fresh traffic with the plan's current journey signature (its list of page paths). **Tier B:** if that signature is older than the current signature rules, or if no fresh journey with the same signature can be planned, it searches for similar successor flows instead, ranked by how closely they resemble the old one. It tells you that the result is a different journey. Tier B needs explicit consent when you promote it (`accept --force --confirm-different-journey`); Tier A does not. Both tiers respect the selected app scope.

A candidate is refused if it comes from a different origin than the live plan's recorded origin, spans more than one origin, or has no witnessed origin, unless you pass `--allow-cross-origin` after reviewing it. When no candidate is found, `regenerate` saves only its empty-search evidence trail in the live plan's data file and says so the first time it writes; it never changes the journey definition. It never changes `tests/generated/<slug>.spec.ts`. Your coding agent reads `diff`, applies the change to the test file, checks it, and then promotes the reviewed plan.

When a proposal keeps the same journey signature, it reports input-type changes on the affected step, but only for input types the step had before. Gaining an input type the step did not have is not counted and shows no change detail. A change from `text` to `email`, `tel`, `url` or `number` is treated as a clear upgrade and does not count toward the “steps regress” summary. Any other input-type change is counted, to be safe. That includes downgrades, lost types, and changes involving types the tool cannot rank. `password` is never ranked, because it changes how values are masked and what value evidence exists. Selector regressions also count toward the summary.

<!-- fixture:cli-help-regenerate -->
```text
Usage:
  replaytest regenerate <slug> [--since-hours N] [--app <name>] [--allow-cross-origin] [--json] [--steal-scan-lock]
      Re-source a stale plan from fresh traffic into the existing proposal slot. It tries
      the same journey first, then a disclosed successor flow; review diff and apply the
      spec delta yourself — replaytest never merges a generated spec. Refuses candidates
      from another origin, spanning origins, or lacking a witnessed origin unless --allow-cross-origin is reviewed.
      When it finds no candidate, its empty live search records only an evidence trail in the plan
      sidecar (disclosed on the first write), never your journey definition.
```
<!-- /fixture -->

## `diff`

`diff <slug> [--json]` shows how the proposed plan differs from the live plan, without changing either file. It is useful after `triage --propose`, `heal --propose`, or `regenerate`, when your coding agent wants to re-read the proposed change before accepting it.

The output starts with a headline. If the proposal is backed by a different flow, the first line is a `⚠ Journey changed` marker, because that is the most important thing `accept` checks. Next comes a one-line `Changed:` summary that counts what moved in each category. Below it are fixed sections in this order: **Assertions → Steps → Plan facts → Caveats → Bookkeeping**. What the test proves comes first, and the bookkeeping is collapsed into one `Source:` line at the end. Each `Changed:` count equals the number of bullets in its section, so the headline never promises fewer items than the document shows.

Every value is shown as an explicit `was → now` pair (arrays item by item, never as a JSON blob), and a changed locator carries its own note on selector quality. When the number of one assertion type changed, the ones that remain and the genuinely added or removed ones all appear as `Removed:` and `Added:` lines. A removed line and an added line can look identical. That happens when they differ only in a field the line does not show (an assertion's `pattern`, `witnessed`, a non-`title` evidence `source`, or an explicit `synthesized: false`). So every such line, on both sides, gets a `differs in: <fields>` note naming the fields that differ. The fields are listed in a fixed compare order, which does not say which field pairs with which. This way the diff never hides one of the two lines, because the difference is real.

`--json` emits the same `SidecarDiff` object that the `triage --propose` / `heal --propose` / `regenerate` envelopes already publish, so a coding agent can read the change as structured data instead of parsing the Markdown.

**One thing `diff` cannot show you.** It works out the change from the two plan files alone, so it never sees a fresh-traffic report. When a locator changed, it shows the plan's own selector quality, but only where the plan records one and the confidence actually moved, the new locator is a guess, or it carries warnings. It does not show what fresh traffic recommends. That evidence exists only in the `triage --propose` or `heal --propose` run that collected it, and is written to the `.proposed.diff.md` file those runs save next to the proposal. Whenever this gap applies, `diff` prints a note at the end (and sets `note` in `--json`). The note names the file to read if one of those runs wrote it. For a proposal made by `regenerate`, which holds no fresh-traffic evidence anywhere, the note says so plainly.

<!-- fixture:cli-help-diff -->
```text
Usage:
  replaytest diff <slug> [--json]
      Re-render the proposed plan sidecar against the current live plan without changing either file.
      --json emits the same structured change object the propose/regenerate envelopes carry,
      so a coding agent reads the delta without parsing the rendered Markdown.
```
<!-- /fixture -->

## `repro`

`repro <distinctId> [--session <sessionId>] [--out <path>] [--force]` — writes a reproduction test (`tests/reproductions/<slug>.repro.spec.ts`) for every journey in a session, whatever its status (errors and abandoned journeys included). The test only replays the recorded steps and checks nothing, so replaying the steps is the whole test: a quick check that the flow still runs. JavaScript errors seen in the recording are noted in a comment at the top of the file. It refuses to overwrite an existing file unless you pass `--force`; `--out <path>` writes elsewhere (single-journey sessions only).

<!-- fixture:cli-help-repro -->
```text
Usage:
  replaytest repro <distinctId> [--session <sessionId>] [--out <path>] [--force]
      Emit a Tier-0 reproduction spec (tests/reproductions/<slug>.repro.spec.ts) for
      EVERY journey in the session, any status (error/abandoned included) — re-driving
      the recorded steps IS the smoke; no assertions are active. Notes witnessed
      exceptions in a header comment. Refuses to overwrite an existing file unless
      --force; --out <path> writes elsewhere (single-journey sessions only).
```
<!-- /fixture -->

## `heal`

`heal [--results <path>] [--since-hours N] [--sample N] [--propose] [--force] [--json] [--steal-state-lock]` — checks every test that genuinely failed in a Playwright JSON-reporter run, all at once. By default it reads `.replaytest/last-run.json`; produce that file with this command:

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=.replaytest/last-run.json ./node_modules/.bin/playwright test tests/generated --reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js
```

The reporter saves a fingerprint of each test file's contents, so `heal` can confirm that the failing line still matches the same recorded action. Then run `replaytest heal` as a separate step.

It first sorts each failure by how it failed. Flaky, timed-out and interrupted tests get no traffic verdict, and neither do failures that look like environment or network problems (it classifies cautiously). For environment or network failures it says that no conclusion about the site was drawn.

It maps each real failure back to its plan, and it shares one traffic scan across the whole batch. A verdict that looks clean for a test Playwright actually failed is flagged, never hidden. A timed-out test that is listed as hand-finished gets the shared hand-finished notice instead of advice to run `scaffold --force`. A mapped failure whose spec lives at a non-default path is disclosed with no duplicate-scaffold advice. `--propose` writes proposals for changed flows plus a rendered plan diff, same as `triage --propose`. If heal finds the shared write lock held by another command, `--steal-state-lock` takes it over, for recovery only. If that command is still running, its one in-flight write may land over recent state.

<!-- fixture:cli-help-heal -->
```text
Usage:
  replaytest heal [--results <path>] [--since-hours N] [--sample N] [--app <name>] [--propose] [--force] [--allow-stale] [--json] [--steal-state-lock] [--steal-scan-lock]
      Batch-triage every genuinely-failed spec from a Playwright JSON-reporter run
      (default .replaytest/last-run.json — produce it with this Playwright command:
      `PLAYWRIGHT_JSON_OUTPUT_NAME=.replaytest/last-run.json ./node_modules/.bin/playwright test tests/generated --reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`, then
      run 'replaytest heal' as a separate step). Classifies failure MODE first —
      flaky/timed-out/interrupted/environment-network specs get no traffic verdict —
      maps each real
      failure back to its plan (a slug header, else the tests/generated/ path
      convention), then runs the same evidence-based check as `triage` for each one,
      sharing ONE traffic scan across the whole batch. A verdict that looks clean on
      a spec Playwright actually failed is flagged, never hidden. --propose writes
      flow-changed proposals + a rendered plan-diff, same as `triage --propose`. Runs older
      than 6 days require --allow-stale; re-run the Playwright command above for current evidence.
      --app <name> confines every slug's evidence to one app declared in
      .replaytest/config.json; the batch still shares ONE traffic scan.
```
<!-- /fixture -->

## `accept`

`accept <slug> [--force] [--confirm-different-journey] [--json] [--steal-state-lock]` — makes the proposed plan the live one: it copies `.replaytest/plans/<slug>.proposed.plan.json` over the live `<slug>.plan.json`, refreshes `<slug>.md` from that JSON, and archives the proposal files it used. `--force` allows replacing the live plan. `--confirm-different-journey` is a separate confirmation, needed when the proposal is based on a different recording. `accept` does not regenerate the test file. On success it prints the next command (`scaffold <slug> --force`). If the slug is listed as hand-finished, it prints the hand-finished notice instead, which says to remove that listing before generating the test again. If accept finds the shared write lock held by another command, `--steal-state-lock` takes it over, for recovery only. If that command is still running, its one in-flight write may land over recent state.

<!-- fixture:cli-help-accept -->
```text
Usage:
  replaytest accept <slug> [--force] [--confirm-different-journey] [--json] [--steal-state-lock]
      Promote .replaytest/plans/<slug>.proposed.plan.json to the live
      <slug>.plan.json, refresh <slug>.md from that JSON, and retire the
      consumed proposal artifacts. Refuses an existing live plan unless --force.
      A different journey needs --confirm-different-journey too; a same-signature
      regenerate proposal is treated as the same journey, so --force alone promotes it.
      Does not re-scaffold; on success prints the next command: replaytest scaffold <slug> --force.
```
<!-- /fixture -->

## `retire`

`retire <slug> [--confirm-retire] [--no-evidence] [--steal-lock] [--steal-state-lock] [--recover-crashed-locks] [--allow-privacy-disclosure] [--json]` — looks at the empty-search evidence collected for a journey (searches of fresh traffic that found no matching journey) and, once enough evidence has built up, archives everything recorded for it into `.replaytest/retired/<slug>/`, together with a `retirement.json` file that explains how to reverse it. That covers the live plan, the generated test, the default-path reproduction test, the frames, any proposal still open, and the older superseded or accepted-proposal archives that earlier steps left behind. Reproduction tests written with `--out` stay where you put them. If you retire a re-planned slug a second time, the new archive gets a timestamp-suffixed name beside the first, and every command that mentions retirement names the most recent record and how many earlier ones exist.

By default `retire` only reads. With no flag it shows the evidence, whether the evidence bar is met, any successor observations (similar newer journeys), and the exact command that gives consent. `--confirm-retire` does the archiving (the bar must be met). `--confirm-retire --no-evidence` retires even below the bar, on your say-so: the tool records your assertion but never treats it as evidence. Each flag alone refuses.

If a retirement is interrupted, it resumes only with `--confirm-retire`. If another `retire` run holds the retire lock, the one command that recovers it is `replaytest retire <slug> --confirm-retire --steal-lock`. A held shared state lock can be taken over with `--steal-state-lock`, but only with the live-write consent described below (an in-flight write from the other command may land over recent state). When both locks are held by owners that are no longer running, use `replaytest retire <slug> --recover-crashed-locks`. The separate-flags form is `replaytest retire <slug> --confirm-retire --steal-lock --steal-state-lock`. Use either `--recover-crashed-locks` or the explicit steal flags, not both. `--recover-crashed-locks` on its own refuses if either lock is missing or any owner is still running.

Keep the archive folder local to preserve the record, and see `retirement.json` to reverse it. A retired slug never blocks a command; `triage`, `diff`, `scaffold`, `preflight`, `regenerate`, `plan` and `accept` each tell you about it. So planning or generating the test again is always allowed as a fresh start.

`retire --allow-privacy-disclosure` lets the archive be written outside Git's ignore rules for that one run only; its local privacy state could then be included in a commit.

When `.replaytest/retired/` is not covered by Git ignore rules, retirement refuses with `privacy-workspace-not-ignored` to protect local privacy state. Keep the archive folder local. Pass `--allow-privacy-disclosure` for that one run only if you accept writing it outside Git's ignore rules. When you do, a best-effort warning is printed to stderr. If Git cannot establish whether there is a repository, retirement prints `privacy-workspace-probe-skipped` to stderr and makes no claim about whether the folder is ignored. The same rule applies when a retirement that was already under way (its journal was published) is resumed.

### What `retire` does and does not guarantee

If a process crashes after `retire` has published its journal (its record of what it is doing), `retire` guarantees that it can recover in a predictable way. It does not claim to solve every filesystem or concurrent-writer edge case. A write by another process in the last moment between the final check and the delete cannot be reliably detected. Also, if something else removes files from a directory that is only partly deleted, that can look the same as `retire`'s own partial work.

All commands that write shared state take turns through `.replaytest/state/.state-lock`. Each time a command takes the lock, the lock records a fresh ID for that hold (its generation). Just before each save, the command checks that the lock still carries its ID, and stops without saving if another command has taken over. `retire` takes its retire lock first and then the shared state lock, and the reverse order is not allowed. `retire` takes the shared write lock briefly for each cleanup step rather than holding it for the whole retirement. `--steal-state-lock` is for recovery only: it may let one in-flight write from a live lock holder land over recent state.

Power loss is a harder case. How well the atomic writes hold up depends on your platform and filesystem. On macOS, `fsync` does not request `F_FULLFSYNC`, so data may still sit in the drive's own cache and be lost. On Windows, directory `fsync` is not available. FAT32 does not promise atomic renames. Losing power before the needed file and directory syncs finish is also a known limit. None of these weaken the crash-recovery guarantee for a killed process (SIGKILL), which is tested separately.

<!-- fixture:cli-help-retire -->
```text
Usage:
  replaytest retire <slug> [--confirm-retire] [--no-evidence] [--steal-lock] [--steal-state-lock] [--recover-crashed-locks] [--allow-privacy-disclosure] [--json]
      Review the accumulated empty-search evidence for a journey and, once the
      evidence bar is met, archive its plan/spec/frames/default-path repro into
      .replaytest/retired/<slug>/ with a reversal recipe. Read-only by default:
      no flag presents the trail, the bar status, successor observations, and the
      consent command. --confirm-retire performs the archival (bar must be met).
      --confirm-retire --no-evidence retires below the bar on operator assertion
      (the tool records the assertion, never adopts it). Each flag alone refuses.
      Keep the archive folder local to preserve the record; see retirement.json to reverse.
      An interrupted retirement resumes only with --confirm-retire. After a crash,
      --recover-crashed-locks performs the combined recovery only when BOTH lock owners
      are dead. Use either --recover-crashed-locks or the explicit steal flags, not both.
      Granular form: --confirm-retire --steal-lock --steal-state-lock.
      All shared state writers serialize through one cross-verb state lock; --steal-state-lock
      may allow one live holder write to land over recent state. Retire still acquires
      its retire lock first, then the shared state lock; the reverse order is forbidden.
```
<!-- /fixture -->

## `suite-status`

`suite-status [--since-hours N] [--json]` — checks every plan from the other direction: is each plan's journey still present in recent traffic at all? It flags dead coverage (no matching traffic; it never says "delete this test," because traffic can be seasonal) separately from unresolvable plans (no recorded signature, never counted as dead) and from plans whose test is not yet generated. If the scan of generated tests' slug headers stops early or hits its cap, `--json` includes `generatedSpecScan.partial`, optionally `generatedSpecScan.cappedBy`, and `generatedSpecScan.unassessedSlugs`. Text output names up to ten of those unassessed rows and, when there are more, adds `… and N more (see --json generatedSpecScan.unassessedSlugs)`. For every unassessed row, advice to generate the test stays withheld. It is read-only and shares one traffic scan across every plan. It differs from `suite-health`: this command checks whether each plan's journey is still in traffic (plan-inventory freshness), not the state of each generated test.

<!-- fixture:cli-help-suite-status -->
```text
Usage:
  replaytest suite-status [--since-hours N] [--app <name>] [--json]
      Reverse pass over every plan: is each one's journey still present in recent
      traffic at all? Flags DEAD coverage (no matching traffic — never phrased as
      "delete this test", traffic can be seasonal) separately from UNRESOLVABLE
      plans (no recorded signature — never counted as dead) and from plans that are
      not yet scaffolded. Read-only; shares one traffic scan across every plan.
      --app <name> counts coverage only inside one app declared in .replaytest/config.json,
      so another site's traffic can neither create nor hide a dead-coverage finding.
      Differs from suite-health: this is plan-inventory freshness; suite-health diagnoses last test runs plus coverage per generated spec.
```
<!-- /fixture -->

## `suite-health`

`suite-health [--json]` — combines your generated tests, your plans and the result of the last `heal` run with a fresh `suite-status` coverage scan that it shares. It shows recorded evidence only: an empty workspace, or a missing `heal` run, is never assumed to be passing. A test file that exists but cannot be read still appears, with `testResult.outcome: "unreadable-spec"`, an unknown lifecycle, and the reason it could not be read, parsed or recognized. A folder that cannot be read is reported as an unavailable inventory, not as "No plans." It differs from `suite-status`: this command reports the health of each generated test, while `suite-status` checks whether each plan's journey is still in traffic.

<!-- fixture:cli-help-suite-health -->
```text
Usage:
  replaytest suite-health [--app <name>] [--json]
      Join local generated specs, plans, and the last heal run with a fresh shared
      suite-status coverage scan. Shows recorded evidence only: an empty workspace or
      absent heal run is never inferred to be green.
      --app <name> is passed straight through to that shared coverage pass.
      Differs from suite-status: this is per-generated-spec health; suite-status is the plan-inventory freshness reverse check.
```
<!-- /fixture -->

## `gaps`

`gaps [--app <name>] [--shape <name>]... [--refresh-sample] [--sample-size N] [--json] [--fresh] [--stored] [--exact] [--since-hours N] [--limit N] [--all]` — shows how your real traffic links to your tests: the gap map. It uses the same named app setup as `sessions`; `--app <name>` picks a declared app for one run. It ranks only rows with no known link to a test in your test inventory. Possible matches with your existing tests, and rows where the evidence is unavailable, stay in separate lanes instead of being counted as "uncovered."

The printed table shows at most 200 rows in each lane of each section by default; `--all` shows every row. `--limit N` shows at most N rows in each lane of each section. The default cap never changes `--json`; an explicit `--limit` still limits each JSON lane.

`--exact` skips the automatic switch to a quick (coarse) scan. It is slower because it reads every session's events, and a forced `--exact` first says how many sessions it will read in the whole project, never a guessed duration. Every table also says whether its scan was exact or approximate. If an exact result stops at the page limit, it says how many sessions were covered instead of claiming the full count.

The quick-scan cache covers the whole project and is reused by every app scope. Before any pending live history work, the CLI estimates every scheduled range. The estimate uses the total at the start of the scan (or a stored observation of that range), the number of data pages plus the final page that marks the end, and an expected pace of five seconds per page. It is not a promise about how long the scan will take. The default 24-hour slices are complete UTC days. When an app accounts for 10% or less of the quick-scan rows seen so far in this scan, the CLI says so, using the count of in-scope rows out of the rows seen so far; the project total is context only and is not the denominator for that 10% threshold. No origin histogram is saved for this check.

`--refresh-sample` precomputes observations of your newest sessions (default 50; max 1000) without changing the main map; a plain `gaps` call never fetches that sample itself. With `--app`, it checks the newest project sessions first and keeps only the ones in that app's scope, within three limits: the fixed 250-candidate cap, the 300-second sample time budget, and the compiled `EXACT_SCAN_MAX_SESSIONS` constant. It records the `candidateLimit` that PostHog returned, the number of sessions it actually checked, and any thin-result finding (a note that the sample is smaller than expected).

**Known limitation:** for a small app in a large project, scoping after the fetch can return fewer sessions than you asked for. The result names the newest project sessions actually checked; it does not claim the app has no older sessions. When PostHog returns fewer candidates and all of them match the app, the finding says so plainly instead of treating a full app share as a shortfall.

The saved sample records the app scope it was taken under, so a plain `gaps` will not show a sample taken under `--app shop` (or the reverse). It says which scope the saved sample belongs to and gives you the refresh command for the scope you asked for.

`--stored` recomputes the map offline from the sealed slices of the local scan store that an earlier live scan saved. It never contacts PostHog, shows no live estimate, and labels where the stored scan came from without claiming it is fresh. When no stored scan covers this workspace, it refuses (exit 1) and gives the command that builds one, rather than quietly running a live scan. When the stored snapshot is only partly sealed, it still serves what is sealed and clearly labels the span it does not cover. It cannot be combined with `--exact`, `--fresh`, or `--refresh-sample`.

<!-- fixture:cli-help-gaps -->
```text
Usage:
  replaytest gaps [--app <name>] [--shape <name>]... [--refresh-sample] [--sample-size N] [--json] [--fresh] [--stored] [--exact] [--since-hours N] [--limit N] [--all] [--steal-scan-lock]
      Read the core traffic-signal link map. It ranks only rows with no known link in
      this inventory; possible existing-suite matches and unavailable evidence stay in separate lanes.
      --refresh-sample precomputes newest-session observations (default 50; max 1000) without changing the core map. With --app it checks newest project sessions first, up to the fixed 250-candidate ceiling and the sample time budget, then reports the actual checked count.
      --exact is slower — it reads every session's events and bypasses the automatic coarse-scan switch. A forced --exact first states its whole-project session count (not a guessed duration). At the structural page ceiling it returns the exact rows read so far and names the covered sessions, pages, and window.
      Coarse scans print an expected-case history estimate before work, report completed UTC days of history, name an up-to-date cache, and label every result with its scan mode.
      --stored recomputes the map offline from the sealed coarse-store slices a prior live scan persisted — never contacts PostHog. It refuses (does not fall back to a live scan) when no stored scan covers this workspace, and loudly labels a partially-sealed snapshot. Cannot combine with --exact, --fresh, or --refresh-sample.
```
<!-- /fixture -->

## `scan-status`

`scan-status [--json]` shows what your local saved scan history (the scan manifest) records. It does not call PostHog, start a scan, or open any saved session-row JSONL file. Before reporting, it checks the manifest against your current local PostHog project, then shows settled coverage, first reads that are waiting for a second read with a matching count, and any saved gaps. The default view is the last 30 days. Each day boundary is shown as your local time paired with its UTC instant, and a "day" means a UTC 24-hour block of history.

Lists are limited in both terminal text and JSON, with totals and truncation information, so the command stays fast (its work grows with the number of saved slices, not with the amount of history) even after years of history. It reports what the manifest records. It does not promise that a later scan will reuse that history, or that a command that loads rows has verified every slice file.

<!-- fixture:cli-help-scan-status -->
```text
Usage:
  replaytest scan-status [--json]
      Reports your saved scan history. Makes no PostHog calls and starts no scan.
      Reads manifest metadata plus local project configuration only; it never opens saved session rows.
      Shows stored settled UTC-day coverage, first reads awaiting a second count-matching read,
      and any recorded capped/interrupted gaps. The default view is 30 days; your scans may use
      a different --since-hours window. --json keeps bounded ranges and gaps structured.
```
<!-- /fixture -->

## Coarse-store lock contention

Commands that write your traffic store coordinate through a single lock; offline reads such as `gaps --stored` take no lock.

Taking over the coarse-store lock with `--steal-scan-lock` is a deliberate recovery step. The scan that held the lock before may still land one write after the takeover, a write it had already verified, so one slice window may briefly hold that scan's data. That is the most it can write. If that write is a checkpoint, the new scan's next checkpoint finds that the store changed underneath it and stops before writing (`coarse-store-lock-fenced`; "fenced" means a scan stopped because the lock or the saved store changed under it). Run it again.

> | `lockCase` | Meaning | What to do |
> | --- | --- | --- |
> | `live` | Another scan that is still running holds the coarse-store lock. | Retry after it finishes, or use `--steal-scan-lock` only after weighing the cost of the scan in progress. |
> | `dead` | The lock, in the current format, names an owner that is no longer running. | Make sure no scan is running, then retry with `--steal-scan-lock`. |
> | `aged` | The owner is still running, but its latest heartbeat (a regular sign of life, matched to the lock's generation) is older than the time limit for reclaiming a lock. | Look into why it may have stalled, then use `--steal-scan-lock` only if it is acceptable to discard the scan in progress. |
> | `malformed` | A lock exists but, after a short settling time, it has no owner that can be verified. | Look at the lock, make sure no scan is running, then retry with `--steal-scan-lock`. |
> | `legacy` | A running owner wrote a lock with an `acquiredAt` field; after a takeover, its writes cannot be stopped. | Use `--steal-scan-lock` only if you accept the recovery risk, then treat the store as possibly mixed until the next full scan. |
> | `swept-claim` | Another scan on this machine swept away this process's private publication claim before any lock was published; `info.malformed` remains `true` as a filesystem-publication fact, not the case label. | Just retry. `--steal-scan-lock` cannot help, because there is no published lock to take over. |

Before reporting one of these cases, a scanning command first waits for a limited time and prints which lock case it sees. The message gives the last verified heartbeat and, when available, the approximate seconds remaining. If several commands are waiting, there is no guarantee about who goes first.

## How scanning works

A scan reads quick summaries of the sessions in your configured PostHog project (coarse session summaries) for the time window you asked for. The first scan costs the most, because there is no saved history to reuse. Later scans can skip days of history that are already settled (a "day" is one UTC day). They **always** re-read roughly the most recent seven days fresh. That recent stretch is why "settled through" normally trails the current time, and why even a scan with a warm cache still does some work.

A complete UTC day becomes settled only after two reads that were not capped, at least ten minutes apart by default, count the same number of sessions for that day. Settled days are saved snapshots. They do not claim that no more sessions can arrive: a session that arrives after the second read shows up after a full re-scan with `--fresh`. `--fresh` re-reads the whole requested window and resets saved history back to first reads, which then need their own later matching reads before they settle again.

`scan-status` describes its own default 30-day window; a scan you ran with a different `--since-hours` can have different saved facts. In `--json`:

- `settledThrough` is the latest end of the stored settled ranges.
- `awaitingAgreement` lists first reads that are still waiting for a second read with a matching count.
- `gaps` lists incomplete reads.
- Each of those lists carries `items`, `total`, `shown`, and `truncated`. `gaps.reasons` reports the stored facts for the whole list, even when its items are capped.
- The stored `reason` values are `capped` (the scan hit its page or time cap in the middle of a period) and `aborted` (the scan was interrupted).
- The `source` values are `coarse-store-manifest`, `local-store` and `local-config`. `coarse-store-manifest` means a saved manifest was read, whether it was used or refused because it is corrupt, has an unsupported format, or belongs to another project. `local-store` means the check of the local store found no saved manifest. `local-config` means local project configuration was unavailable before a manifest could be read.
- `lastUpdated` is the latest stored `sealedAt` or `observedAt` time, never the time the manifest was last written.

## `reconcile`

`reconcile [--apply] [--dry-run]` — reports plan data files that a newer plan batch for the same recorded session has replaced (superseded). The default and `--dry-run` only report; `--apply` renames the superseded files to `.superseded.*` (it never deletes them, and never touches your generated test files).

<!-- fixture:cli-help-reconcile -->
```text
Usage:
  replaytest reconcile [--apply] [--dry-run]
      Report sidecars superseded by a newer plan batch for the same recorded session.
      Default and --dry-run only report; --apply renames sidecars to .superseded.*.
```
<!-- /fixture -->

## `fix-selector`

`fix-selector <slug> [--apply] [--dry-run] [--occurrence N] [--prefer stability|fidelity] [--from-triage-verdict] [--allow-privacy-disclosure] [--json] [--steal-state-lock]` — shows the newest saved selector patch from a `heal` or `triage` run. `--apply` replaces exactly one emitted occurrence (use `--occurrence N` when several match) and updates exactly one matching action in the plan. It records the repair in `locatorRepairs[]` and re-renders the Markdown plan with a `## Maintenance history` section; that history is a record of maintenance, not recording evidence. If zero or several plan actions match, it warns instead of guessing an update. A Markdown plan copy that was edited by hand is kept, with a warning, and never overwritten.

`--apply` refuses before changing, or recording a fingerprint for, a test whose slug is listed in `.replaytest/hand-finished.json`, and prints the shared notice telling you to remove that listing first.

`--from-triage-verdict` tolerates an earlier hand edit: it applies the diagnosed verdict even when the old locator text is gone, and reports "already applied" rather than overwriting silently. `--prefer fidelity` is the default (apply exactly what was recorded); `--prefer stability` selects a recorded alternate selector, but only when the latest fresh traffic also verified it. If fix-selector finds the shared write lock held by another command, `--steal-state-lock` takes it over, for recovery only. If that command is still running, its one in-flight write may land over recent state.

`fix-selector --allow-privacy-disclosure` lets a value that looks like personal data (email, card or phone number, token) be written into a committed test file — for that one run only.

`fix-selector --json` prints the result, and any privacy disclosure, as structured JSON.

With `--apply`, if a saved old or replacement locator looks like personal data (an email address, a long card or phone number, a PostHog project token), the command reports `privacy-disclosure-required` before it writes either the test file or the selector ledger. Review the redacted finding, then repeat with `--allow-privacy-disclosure` for that one run only. `--json` carries the same code and disclosure, for programs to read.

If the test file is not at its default path (`tests/generated/<slug>.spec.ts`), `fix-selector` looks for a renamed or moved file the same way `suite-status` does: a limited search of generated tests' slug headers (the slug comment at the top of each file). If that search hits its limit, it refuses with `fix-selector-spec-scan-capped`. If two or more files have a matching header, it refuses with `fix-selector-spec-ambiguous` and lists the first two paths, sorted, relative to your workspace. A header after line five, a mention of the slug only in a file's body, and a symlinked file do not count as matches. When a repair is made at a moved path, it does not update the fingerprint record that is keyed to the default path. In `--json` it reports `hashRecorded:false` with the reason.

<!-- fixture:cli-help-fix-selector -->
```text
Usage:
  replaytest fix-selector <slug> [--apply] [--dry-run] [--occurrence N] [--prefer stability|fidelity] [--from-triage-verdict] [--allow-privacy-disclosure] [--json] [--steal-state-lock]
      Show the newest persisted triage or heal selector patch by default. --apply replaces
      exactly one emitted occurrence; when several match, choose one with --occurrence N.
      --from-triage-verdict tolerates a prior hand-edit: it applies the diagnosed verdict
      even when the old locator string is gone, and reports "already applied" if the spec
      already holds the fresh locator (never overwrites a hand-edit silently).
      --prefer fidelity is the default; --prefer stability selects a recorded alternate
      only when the latest fresh traffic also verified it.
```
<!-- /fixture -->

## `dashboard`

`dashboard` — starts the local dashboard (a browser GUI over these same commands) at `http://127.0.0.1:4319` (override the port with `PORT`). It reads and writes the repo you run it from, same as every other command. See the [Dashboard guide](./dashboard-guide.md) for a tab-by-tab walkthrough.

<!-- fixture:cli-help-dashboard -->
```text
Usage:
  replaytest dashboard
      Start the local dashboard (a browser GUI over these same commands) on
      http://127.0.0.1:4319 — override the port with PORT. Reads/writes the repo
      you run it from, same as every other command.
```
<!-- /fixture -->

## `help`

`help` (or `--help`, `-h`, or running `replaytest` with no arguments) — prints the full command list shown at the top of this page.

---

**How the command blocks on this page are made:** every fenced block above marked `<!-- fixture:... -->` is copied word for word from a checked-in file, and that file is regenerated by running the real, installed CLI. None of it is typed by hand. Each `--help` output shown above is the real output of that command.
