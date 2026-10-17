# Concepts

`replaytest` has a small vocabulary. This page defines each term once, in plain English, and says why it exists and where you'll see it: in a CLI command, a dashboard tab, or both. The terms follow the order of the process. Your recorded sessions are grouped into journeys, your coding agent picks a journey to get a plan, the plan becomes a test scaffold, and Suite Health helps you keep the tests working. If you only read one page before using the tool, make it this one.

Here, a "user" is anyone whose browser session PostHog records: a person, or an AI agent browsing on someone's behalf.

---

## Journeys and canonical journeys

A **journey** is one path a real user took through your app in one recorded visit: the pages they visited, in order, from where they started to where they stopped. `replaytest` reads this from PostHog, the session-replay and analytics tool you already use, not from your app's source code. It never looks at your app's files, only at what really happened.

Two different users who both went `/cart` → `/checkout` → `/confirmation` took the *same* journey. It doesn't matter that they are different people, on different days, maybe with different items in the cart. `replaytest` puts them in one row, called a **canonical journey**: the single row that stands for every session that took that route. Each row is ranked by how many sessions took it, for example "243 sessions did entry → form → confirmation". You see one row instead of 243 near-identical ones.

This grouping is the step between your raw recordings and your tests. First, every session is converted into one common format that doesn't depend on PostHog. Then sessions are grouped into journeys. Two sessions count as the same journey when they have the same **signature**: the ordered list of page routes visited, with record ids in the address replaced by a pattern. So `/invoices/inv-1003` and `/invoices/inv-2041` both read as `/invoices/:id`. They are the same shape of journey, even though they touch different records.

Every journey also has an **outcome status**: the strongest thing the recording actually showed, never a guess at what the user was trying to do.

- *Completed*: a form submit, then arriving on a new page.
- *Navigated*: typed input, then arriving on a new page, with no form submit seen. This is how a "create" looks in apps that save inline instead of behind a submit button.
- *Submitted*: a form submit with no distinct new page after it.
- *Abandoned*: none of those was seen.

Each label is a minimum, not a verdict. An event the recording missed can make a real completion read as abandoned, and the cheaper approximate scan can't recognize navigated journeys at all (see [exact vs. approximate scans](#exact-vs-approximate-scans--data-source-honesty)).

**Where you see it:** `replaytest sessions` lists your journeys ranked by how many sessions took each; the Sessions tab of the dashboard shows the same list with filters (completed / navigated / submitted, time window, etc.).

---

## App scope

One PostHog project can hold traffic for more than one site. An **app scope** lists the web address prefixes that belong to one app, so that ranking counts only sessions that visited a page under those prefixes.

Declare named scopes in `.replaytest/config.json`, for example `{"apps":{"shop":["https://shop.example"]},"app":"shop"}`. Use `--app <name>` on `sessions` or `gaps` to pick a different declared app for a single run.

A scoped view tells you how many sessions it left out because they belonged to other apps, and it reports separately the sessions that showed no page address at all. Scoping works per session: if a session visited any matching address, its whole recorded path stays in scope. Prefix matching is strict: `https://shop.example` does not include `https://staging.shop.example`, so list each subdomain you want included.

Without a scope, `sessions` results that span several sites list every site found in the scan and suggest declaring one. Results from a single site show no warning.

**Where you see it:** the `sessions` and `gaps` commands (and their `--json` output) and the banner on the dashboard's Sessions tab tell you when a scope is applied and what it left out. The same banner and the `sessions` command also suggest declaring a scope when your results span several sites. In that case each ranked row also lists its sites in a `sites` column; results from a single site, scoped or not, look the same as ever. `gaps --refresh-sample` takes its spot-check of your newest sessions inside the selected scope too, and a saved spot-check is never shown under a scope it wasn't taken in.

---

## Families

With real traffic, one flow rarely produces exactly one signature. People join a flow at different pages, or get different distances through it before leaving. So the exact view can split what you'd call "the checkout flow" into several rows, each one counting only part of it.

A **family** groups those variants of one recorded route into a single ranked row, for display only: "your checkout family: 820 sessions across 5 variants, most people drop at the cart". It does not change what a plan or a generated test is based on. Plans, tests and coverage always stay tied to the exact signature, so families are a way to rank and read the list, not a new kind of test. Grouping follows the shape of the path (one journey's steps are a continuous stretch inside another's), and never guesses what the user was trying to do.

**Where you see it:** the `Journey families` toggle on the Sessions tab (and the `--families` flag on the `sessions` command). The Gap map states which of the two views it is using, because that choice changes which rows and evidence it shows.

---

## Test plans and sidecars — the pivot artifact

A **plan** is the Markdown file `replaytest` writes for one journey, in words a person can read. It lists what happens (the steps), the selector it recommends for each step (how the test will find that element), what the test will check (its assertions), and every caveat the recording forced on it, such as masked fields, kinds of input the recording doesn't capture, and data the journey needs to run. The plan is the centre of the whole process. It is the one file your coding agent is meant to read and approve before any test code exists. Nothing after it is a black-box guess, because the plan states its own evidence and its own gaps.

Next to each plan's `.md` file sits its **sidecar**: the plan's data file, `<slug>.plan.json`. (The slug is the short name of a plan, for example `appt-6`.) It holds the same information in a form programs can read: selectors, assertions, data requirements, and alternate selectors the recording also showed. Every other command (`scaffold`, `triage`, `fix-selector`, `suite-health` and so on) reads this data file. The `.md` is produced from the same data, so the two can never quietly drift apart.

When `fix-selector --apply` makes a safe update, it records a history of the repair in `locatorRepairs[]` and shows it under `## Maintenance history`. That section describes later maintenance only, never the original recording evidence. When the command changes one line of the test, it also saves a fresh fingerprint (a "baseline") of the whole test file. If the verdict is `already-applied` (the fix is already in place), it refreshes only the earlier plan fingerprint, and never creates a fingerprint for a test file that never had one. When `fix-selector` finds your hand-fix already in place, it records the fix as confirmed only if the new selector appears exactly once, on the action line of the diagnosed step (not in a comment or a string). replaytest keeps that record, but no command's output depends on it.

A test that was finished after replaytest generated it, by your coding agent or by hand, can be marked so the tool leaves it alone. List its slug in `.replaytest/hand-finished.json` (the "hand-finished registry"), the one file in `.replaytest/` replaytest asks you to commit. Each entry records a test slug, the date it was marked finished, and a reason. Slugs are built from page-route segments, so review them and your reasons before committing. `replaytest` then warns you that `scaffold --force` would overwrite that test, and `fix-selector --apply` refuses to change it or save a fresh fingerprint for it. This file is separate from `.replaytest/config.json`, which holds local-only wizard-step settings. Suite Health and the dashboard do not show these warnings. Running `scaffold --force` directly still overwrites the file: the registry is a warning, not a lock.

If the registry file is broken, the commands stop instead of guessing. Invalid JSON, a top level that isn't a list, or an entry that is invalid, duplicated or missing its audit fields makes `suite-status`, `heal`, `preflight`, `triage`, `accept` and `fix-selector` refuse to run until the file is repaired. A declaration with neither a plan nor a spec is skipped by commands that work through your plans, and no command reports it; remove it when you no longer need it. To fix it, restore the missing file or remove the entry.

Turning a plan into a runnable test is a separate, deliberate step (the `scaffold` command). Reviewing the plan is the review point, and it happens before any test code exists.

**Where you see it:** `replaytest plan <distinctId>` writes both files to `.replaytest/plans/`. (`<distinctId>` is PostHog's id for one user; each row of `sessions` shows one.) The Plans tab of the dashboard shows the same content for browsing.

---

## Tier-1 assertions and the honesty boundary

`replaytest` only checks facts a recording directly showed, never an inference about what the outcome *meant*. These checks are called assertions. Concretely, there are exactly three conceptual assertion types:

- **Final URL** — the journey ended on this page.
- **Page shows text** — this text was visible on the final page.
- **No console errors** — the browser console stayed clean during the journey.

The **Page shows text** type can render as a text-visibility assertion (`getByText(...).toBeVisible()`) when the witnessed text is in the page, or as `toHaveTitle` when the witnessed text is the page title. Those are two Playwright renderings of the same conceptual assertion type, not additional assertion types.

This limit is deliberate, not something waiting to be lifted. The tool will never check something like "the order total was correct" or "the payment succeeded on the backend" from a recording alone. A session replay can show that a confirmation page loaded and said "Thank you", but it can't prove your database saved the order. Generated tests are a **UI-flow regression check** (they catch changes in how your screens behave), not full-stack, backend-verifying end-to-end tests. Where the recording can't know something, such as a masked password's real value or whether a click was a real form submission, the plan says so instead of guessing. And a generated test never weakens or drops a check just to turn red into green.

**Where you see it:** every plan's "Assertions" section and every generated spec's actual `expect(...)` calls; the assertion type tooltips in the Plans tab explain each one in one line.

---

## Exact vs. approximate scans — data-source honesty

Reading tens of thousands of sessions in full detail on every request would be slow and would use up your PostHog API allowance. So `replaytest` runs two kinds of scan, and it always tells you which one produced what you're looking at:

- **Exact (detailed) scan** — reads each journey in full: its real signature, completion status and step-by-step evidence. Slower, but everything it shows was directly seen.
- **Coarse (approximate) scan** — a much cheaper summary of each session, used when there is a lot of traffic. It still gives real facts, such as whether a session submitted a form and how many rage clicks (repeated clicks on the same spot) it had. But it can't always tie a fact to one specific page the way an exact scan can, so those rows are labelled "likely" or "coarse" rather than shown as a precise per-page fact.

Neither mode is the faulty one. Coarse scanning is a deliberate trade-off that makes workspaces with tens of thousands of sessions usable at all. What matters is that an approximate number never passes as an exact one. A coarse-scan row says so on the row itself. A capped or partial scan says how much of your traffic it covered. Anything the current scan mode can't work out is labelled "couldn't check" or "not assessed", never reported as a clean zero.

**Where you see it:** the yellow "This is an estimated view of N sessions" banner and the `≈ approximate` badges on the Sessions tab. In `--json` output: the `meta` and `provenance` fields, plus the extra fields `scanMode`, `backfillEstimate`, `projectWideScan` and, for a gaps spot-check refreshed inside an app scope, `scopedSample`. On the Gap map: the confidence column (`Seen directly` / `Strong hint` / `Couldn't check`).

---

## The gap map

The gap map answers a different question than "what did users do" — it asks **"what does my test suite still not cover?"** `replaytest gaps` (and the dashboard's Gap map tab) looks at a small set of concrete traffic **shapes** — kinds of behavior worth testing — and reports, per shape, which real traffic has no known linked test yet:

- **Form submissions** — users who submitted a form (sign-ups, checkouts, saves).
- **Long multi-step flows** — users who worked through many steps on one page (wizards, long forms).
- **Rage clicks** — users who clicked the same spot repeatedly, usually a sign something felt broken or slow.

Every row says how sure it is (its **confidence**): directly seen in the recordings, a "strong hint" from a coarse scan, or "couldn't check". Every claim is deliberately narrow. `no-known-link` means the tool found no `replaytest` plan, and no likely match (based on names or patterns) in your existing hand-written tests, for that traffic. It does **not** claim that a test never ran, that the rest of your suite lacks coverage, or that a product behavior is missing. Rows can overlap (one session can appear under more than one shape), so don't add their counts into one grand total.

Beneath the shape rows sits a separate, smaller **spot-check of your newest sessions**: a limited sample of your most recent real traffic (screen sizes, whether logins were seen, console errors, JavaScript error types), shown for a look, not as a coverage claim. It reads "not assessed" until your coding agent explicitly asks it to refresh.

An unscoped sample states how many sessions were requested versus returned, and the time window they cover. An app-scoped sample states instead the candidate limit recorded for that search (the returned set, capped at a hard limit), how many of the newest project sessions were checked, how many were kept for that app, and the same time window. A saved sample without a recorded candidate limit leaves it out rather than assuming 250.

**Where you see it:** `replaytest gaps`, `replaytest sessions --shape <name>` for one shape at a time, and the Gap map tab.

---

## Suite health and the living suite

Once tests exist, keeping them maintained has to mean something ongoing, not a one-time event. `replaytest` treats a generated set of tests as a **living suite** with its own repair loop, built around three commands:

- **`triage`** — works out *why* one generated test may be failing, by checking fresh real traffic for the same journey. It gives one of a few verdicts: the selector went stale (the element still exists but its attributes changed); the flow itself changed (a step or the outcome moved); the journey no longer shows up in traffic; evidence of a genuine product regression; or "not enough evidence to say". It never changes your journey definition unless your coding agent asks it to propose a fix. When a live check finds nothing wrong, it records only its own evidence trail in the plan's data file, and tells you about the first such write.
- **`heal`** — the same diagnosis, run in one go over every test that genuinely failed in one Playwright run. It shares a single traffic scan instead of repeating it for each test. This is the form to use in CI (your automated build checks).
- **`accept`** — replaces your live plan with a proposed one (written by `triage --propose` or `heal --propose` when the flow changed), after your coding agent has read the differences. It never overwrites your live plan silently.

**Suite Health** (the dashboard tab, and `suite-health --json` for scripts and coding agents) is the one place to decide what needs attention. Every generated test is a row with separately labelled facts: its Lifecycle (Planned → Scaffolded → Executed → Passing), Spec file / diagnosis state, Latest recorded result, last failure diagnosis, and *current* production coverage. Coverage is recomputed live, because a test can still be green while the journey it covers has quietly stopped happening in production. Nothing is assumed to pass: a test your last run didn't execute reads "not evaluated in this run", not "presumed passing". If a test file exists but can't be read, the row stays, says "Spec exists but could not be read", and shows an unknown lifecycle and reason. It is never turned into a missing test or a pass.

**Where you see it:** `replaytest triage <slug>`, `replaytest heal`, `replaytest accept <slug>`, and the Suite Health tab. See [`for-ai-agents.md`](./for-ai-agents.md) for the full step-by-step repair loop, written for a coding agent fixing a failing test.
