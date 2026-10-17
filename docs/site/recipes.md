# Recipes

Short how-to guides for common situations. Run every command from your repo root.

## Apps that need a login

Set `TARGET_APP_STORAGE_STATE` to point Playwright at your saved login state. Create that state once, after a manual login or with your own login script, using Playwright's `context.storageState({ path })`. Then run the generated tests with it:

```bash
TARGET_APP_STORAGE_STATE=playwright/.auth/user.json npx playwright test tests/generated
```

If a login appears in the recording, run `replaytest auth-setup`. It reads the plan data files (`<slug>.plan.json`) and writes one shared `playwright/auth.setup.ts`. If that file already exists, it refuses to overwrite it, because it may hold sign-in steps you finished by hand; delete it if you want a fresh one. That file opens the login page by its path only, uses the selectors seen in the recording, and leaves marked placeholders for environment variables where the login values go. It then prints a config snippet for your coding agent to paste in. It never edits your config or stores credentials: a coding agent that can read your app's code fills in the placeholders. For a journey that includes a login, you still have two choices: supply a real test credential, or delete the login steps and use `TARGET_APP_STORAGE_STATE`.

## Write safety

Generated test scaffolds and reproduction tests replay real writes in your app, including form submissions. Every generated file says plainly when it performs a write. Point `TARGET_APP_URL` at staging or seeded test data, never at production.

## Data safety and personal data

The full privacy promise is on the [Privacy](./privacy.md) page. The bullets below are practical details.

- PostHog **masks input values by default**. Keep it that way. Plans check page structure and text seen in the recording, never typed values. Masked fields show up as clear "you must supply this" markers.
- Error details show **only a count and a type** (for example `1 × TypeError`). Error messages are left out because they can contain personal data.
- replaytest only **reads from PostHog** and runs entirely on your machine. Your credentials live in your local `.env`. `init` makes sure both `.env` and `.replaytest/` are gitignored: it creates a minimal `.gitignore`, or adds any missing entries to your existing one.
- `replaytest frames` saves, on your machine, a copy of the page structure (the DOM) and a screenshot for each step, for a coding agent to look at. These contain real content from past users: keep them local, and never commit or share them.

## Keeping tests alive

- **A generated test started failing?** Run `npx replaytest triage <slug>`. It checks fresh traffic for the same journey and explains *why*: the selector went out of date, the flow changed, or the journey disappeared, with a stated priority. It never changes your journey definition unless you pass `--propose`. Healthy live checks save only their own evidence trail in the plan's data file (`<slug>.plan.json`), and the tool says so the first time it writes. Proposals go to `.proposed.*` files that your coding agent can compare against the live plan.
- **Check every failure from one Playwright run?** First write the JSON report that `heal` reads, then run `npx replaytest heal`:
  ```bash
  PLAYWRIGHT_JSON_OUTPUT_NAME=.replaytest/last-run.json ./node_modules/.bin/playwright test tests/generated --reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js
  npx replaytest heal
  ```
  The reporter saves a fingerprint of each test file's contents. That lets `heal` confirm that the failing line still matches the recorded action it was generated from.
  To keep the shortcut, add this to your own `package.json`:
  ```json
  { "scripts": { "test:heal": "PLAYWRIGHT_JSON_OUTPUT_NAME=.replaytest/last-run.json ./node_modules/.bin/playwright test tests/generated --reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js" } }
  ```
- **A selector went out of date, but the flow is the same?** `npx replaytest fix-selector <slug>` shows the one-line patch diagnosed by your most recent `heal` or `triage` run. Adding `--apply` writes that one reviewed change and updates the one matching step in the plan. The repair is recorded in `locatorRepairs[]` in the plan's data file and in a `## Maintenance history` section of the Markdown plan; this history is a record of repairs, not recording evidence. If no plan step matches, or several do, it warns instead of guessing. If the slug is listed in `.replaytest/hand-finished.json`, `--apply` refuses before it changes or marks the test file, and it tells you to remove that listing first. For other slugs, it refuses whenever the evidence is ambiguous.
- **Re-generating won't overwrite your work unless you say so:** `plan` and `scaffold` refuse to overwrite files they didn't write. `--force` is your explicit go-ahead, and `--out <path>` writes a fresh file for your coding agent to compare. The warnings that protect hand-finished tests apply only to slugs listed in `.replaytest/hand-finished.json`, and `scaffold --force` still overwrites when you ask for it. Your finished tests are yours; git is the safety net.
- **A broken hand-finished list stops the commands:** if `.replaytest/hand-finished.json` is broken, then `suite-status`, `heal`, `preflight`, `triage`, `accept` and `fix-selector` all refuse to run. Broken means the file is not valid JSON, is not a list, or has an entry that is invalid, duplicated or missing a required audit field. Repair the file and run the command again. A declaration with neither a plan nor a spec is skipped by commands that work through your plans, and no command reports it; remove it when you no longer need it.
- **Sessions with errors:** `npx replaytest sessions --with-exceptions` lists only journeys where the recording captured a JavaScript error. `npx replaytest repro <distinctId>` writes a reproduction test (in `tests/reproductions/`) that replays the recorded steps and makes no checks. Replaying the steps is the whole test: a quick check that the flow still runs.
- **Is my whole suite still healthy?** `npx replaytest suite-health` combines your generated tests, your plans and your last test run with fresh production traffic. A test your last run did not execute is never reported as passing. `npx replaytest suite-status` answers a narrower question: is each plan's journey still in recent traffic at all? It flags "dead coverage" (no matching traffic) but never tells you to delete the test, because traffic can be seasonal.
- **Missing coverage, not a failing test?** `npx replaytest gaps` ranks the traffic your users actually produce by whether a known test is linked to it. You can see what to test next, not just what is broken.

## Current limitations

- **PostHog only, for now.** No other session-replay or analytics tool is supported yet.
- **Three kinds of check only (Tier-1).** Generated tests check the final page address, text visible on the page, and no console errors. They check only what the recording showed, never outcomes the tool guessed.
- **Checks the UI path, not the whole stack.** The tests do not confirm that anything happened in your backend.
- **Very large projects are scanned roughly first.** When you have very many sessions, replaytest first runs a quick, approximate scan. The command tells you when a scan is approximate or capped, and then re-reads the top rows in full detail.

See [How it works](./how-it-works.md) for why these limits are deliberate, and [Concepts](./concepts.md) for the meaning of the terms these recipes use (journey, Tier-1 check, gap map).
