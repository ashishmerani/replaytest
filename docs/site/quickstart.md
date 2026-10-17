# Quickstart

This page takes you from nothing installed to a running generated test. Your coding agent can do every step.

## Requirements

- **Node.js** — see the compatibility table below
- **PostHog CLI**, installed and on your `PATH` — `replaytest` runs it behind the scenes
- **`@playwright/test`** in your repo, to run the generated tests
- **PostHog** (US/EU Cloud or self-hosted) with autocapture enabled on your app. Autocapture is PostHog's automatic recording of clicks, form submits and page views. Session replay is recommended: it gives the tool better selectors and the browser console's error count, which backs the "no console errors" check.
- A **PostHog personal API key** with read access to your project (queries and session recordings). A read-only key is all it needs — `replaytest` never writes to PostHog.

## Compatibility

| Component | Compatibility |
| --- | --- |
| `@playwright/test` | Floor `>=1.30.0` (optional peer); verified at 1.30.0, 1.61.0, 1.62.1, and 1.63.0; between = expected but untested. |
| Node.js | `engines >=22`; verified on Node 22 LTS and Node 24 (full test suite + a packaged-install consumer check). |
| PostHog CLI | Verified at 0.7.32, 0.8.4, 0.9.1, 0.9.4, 0.10.0, 0.13.3, and 0.16.0; the install command pins the newest. |
| PostHog | Cloud/self-hosted service, unversioned — we depend on three API surfaces: the HogQL query API, the session-recordings list API, and the recording-snapshot endpoint; `doctor` probes all three live. |

Verified versions are exact; versions between the floor and a verified version are expected but untested; `doctor` warns, never blocks.

Your app's PostHog snippet or posthog-js is yours and unpinned; `doctor` detects data-richness drift empirically through its probes, not version pins.

Install the verified PostHog CLI version:

```bash
npm install -g @posthog/cli@0.16.0
```

Newer versions may also work. `doctor` tells you if yours is outside the tested range. New releases are checked and this pinned version is updated on a rolling basis.

## Install

Install from npm:

```bash
npm install --save-dev replaytest
```

Then run commands with `npx replaytest <command>` (it uses your local install) or `./node_modules/.bin/replaytest <command>`. **Always run from your repo root** — the tool writes its files, and looks for its settings, in the current directory.

## Quick start

Your first run, in five steps: `init` → `sessions` → `plan` → `scaffold` → run the generated test.

**1. Connect your PostHog project.** This writes a `.env` file in your repo and adds both `.env` and `.replaytest/` to `.gitignore`. If you have no `.gitignore`, it creates a small one; if yours lacks either entry, it adds the missing one. `replaytest` reads credentials only from this `.env` file and ignores shell environment variables, so there is one clear place to look:

```bash
npx replaytest init --project <your-project-id> --token <personal-api-key>
# EU Cloud or self-hosted? add: --host eu.posthog.com  (or your domain)
```

**2. See what your users actually do:**

```bash
npx replaytest sessions
```

This lists your traffic from the last 30 days; use `--since-hours N` to change that. Sessions that took the same route are grouped into one row, so you see **journeys ranked by how many sessions followed them**, such as "23 sessions did entry → form → confirmation". Each row also shows whether the journey was completed, and one example user id.

To see which journeys already have a plan or test, coding agents can use the `coverage` data in `sessions --json`. The dashboard shows the same thing visually.

**3. Turn a journey into a plan that your coding agent can review** (use a user id from the `sessions` output; it appears as `<distinctId>` below):

```bash
npx replaytest plan <distinctId>
```

One user's traffic often holds **several** journeys that can become plans, so one `plan` call may write several plans, one per journey. The output lists each file.

A journey can become a plan (the tool calls it "plannable") when the user either submitted a form, or typed into a field and landed on a brand-new page without one. The second case is a "create" that saves without a Submit button, as many workspace and CRM apps do.

Each journey gets two files:

- a plan you can read: `.replaytest/plans/<slug>.md`. `<slug>` is the short name the tool gives the plan, for example `appt-6`.
- the plan's data file, `<slug>.plan.json` (the tool calls it a sidecar), which later commands read.

The plan lists:

- the steps the user took;
- the recommended selectors (how the test finds each element on the page) and where each one came from;
- the checks the test will make: the final page address, text that should be on the page, and no console errors (these docs call them Tier-1 assertions);
- every caveat the recording forced, such as masked fields, input types it could not capture, and exceptions seen in the recording.

Checks come only from what the recording actually showed. One thing a recording cannot capture is the keystroke that saves an inline edit. The plan lists it as a step, clearly marked SYNTHESIZED, and never as a check. The tool also samples other matching sessions (8 by default), so each check rests on evidence from a group of users, not just one.

**Your coding agent should read the plan before going on. This is the review point.**

The example plans checked in under `.replaytest/plans/` are a curated sample, not every plan the tool has written locally.

**4. Write a Playwright test scaffold** (`scaffold` does this; use the `<slug>` from step 3):

```bash
npx replaytest scaffold <slug>
```

This writes `tests/generated/<slug>.spec.ts`. A comment block at the top says what the draft is and what is still left to finish: the `// TODO` markers for locators, the values to fill in for masked or required fields, and login setup if your flow needs it. It also carries a rule: never weaken a check just to make a test pass.

**5. Finish and run the generated test.** Fill in the `// TODO` markers (see [For AI agents](./for-ai-agents.md)). Then run it:

```bash
TARGET_APP_URL=https://staging.your-app.example npx playwright test tests/generated
```

`TARGET_APP_URL` is the address of the app the test runs against. Point it at staging or seeded data, never production, because generated tests submit real forms.

**Other commands you may need:** Run `npx replaytest doctor` when something seems wrong with your PostHog setup. Run `npx replaytest preflight <slug>` before running the generated test when you want a quick local check of its selectors.

If your repo has no Playwright config yet, this minimal one works:

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: process.env.TARGET_APP_URL || 'http://localhost:8000',
    // Optional: saved login state (see "Apps that need a login" in Recipes)
    ...(process.env.TARGET_APP_STORAGE_STATE ? { storageState: process.env.TARGET_APP_STORAGE_STATE } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

For setup details, see [Apps that need a login](./recipes.md#apps-that-need-a-login).

If the recordings behind your saved plans include a login, run `npx replaytest auth-setup` before your first Playwright run. It writes one shared `playwright/auth.setup.ts` and prints the lines to add to your Playwright config. If that file already exists, it refuses to overwrite it, because it may hold sign-in steps you finished by hand; delete it if you want a fresh one. It does not edit `playwright.config.*` or store credentials.

## Next

- [How it works](./how-it-works.md) — what happens behind these five steps, and why every check in a generated test is something the recording actually showed.
- [CLI reference](./cli-reference.md) — every command and flag, including the ones this quickstart skips (`gaps`, `triage`, `heal`, `suite-health`, and more).
- [Recipes](./recipes.md) — apps behind a login, running generated tests safely, handling personal data (PII), and keeping your generated tests passing as your app changes.
