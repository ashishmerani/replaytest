<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/wordmark-accent-dark.svg">
    <img src="assets/logo/wordmark-accent-light.svg" alt="replaytest" width="200">
  </picture>
</h1>

**replaytest reads your production traffic, sorts it into user journeys, and turns the most common ones into Playwright test scaffolds.** Your coding agent gets what it needs to finish them and keep them working: page snapshots from the real recording and a repair skill.

It works from the sessions PostHog already records. For each journey your coding agent picks, it writes a plain-English test plan to review, then a test scaffold from that plan.

It is for teams that already use PostHog and want regression tests based on what their users really do. PostHog is the only source supported today (more providers are planned). replaytest has been tested on thousands of sessions of synthetic traffic in a live PostHog project.

**Works with your AI coding agent:** Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, or any agent that can run terminal commands.

## Contents

- [About](#-about)
- [How it works](#-how-it-works)
- [Install](#-install)
- [Quickstart](#-quickstart)
- [Commands](#-commands)
- [Dashboard](#-dashboard)
- [Privacy](#-privacy)
- [Docs](#-docs)
- [License](#-license)

## 📖 About

Your users show you every day which flows matter, and PostHog already records them. replaytest turns the paths they actually take into Playwright regression tests. There is no new recorder to install, and nothing is sent anywhere except your own PostHog project.

A **journey** is one path a user took to get something done, such as signing up or paying an invoice. A user is anyone whose browser session PostHog records: a person, or an AI agent browsing on someone's behalf.

| Command | What it does | Why it matters |
|---|---|---|
| `sessions` | Groups recorded sessions into journeys and ranks them by how many sessions took each one | Your first tests cover what people really do, not a guess |
| `plan` → `scaffold` | Writes a plain-English test plan, then a Playwright test scaffold from it | Your coding agent reviews the plan before any test code exists |
| `frames` | Rebuilds the page and a screenshot at each step from the real recording | Your coding agent looks instead of guessing selectors |
| `gaps` | Lists real traffic with no known linked test, such as form submits and rage clicks | You see where tests are missing |
| `triage` / `heal` | Checks fresh traffic and says why a test went red: the page changed, the flow changed, or users stopped taking that path | Your coding agent knows whether to fix a selector, re-plan, or retire the test |
| `fix-selector` / `accept` | Applies a reviewed repair, either a selector patch or a new plan you've checked with `diff`, and refuses rather than guess | A repair never quietly changes what a test checks |

The commands your coding agent reads results from have `--json` output, and every refusal has a code that `explain <code>` spells out. The package also ships a `replaytest-repair` skill and a maintenance guide for your coding agent. After installing `replaytest` as a project dependency, copy or link `node_modules/replaytest/skills/replaytest-repair` into your coding agent's skills folder to use the repair skill. See [For AI agents](docs/site/for-ai-agents.md) and the [CLI reference](docs/site/cli-reference.md).

## 🧭 How it works

```
PostHog sessions → journeys (split, grouped, ranked)
                         ↓  your coding agent picks one
               test plan (Markdown, reviewed)
                         ↓
               Playwright test scaffold (.spec.ts)
                         ↓
               your coding agent finishes it → passing test
```

1. **Read.** replaytest reads your recorded sessions from PostHog: the pages visited, the clicks and the form submits.
2. **Find journeys.** It splits each session into the flows it contains, groups the same flow across users, and ranks them by how many sessions took each one. The split is a best guess, so now and then one flow becomes two journeys. `sessions` shows the ranked list.
3. **Plan.** For a journey that finished, it writes a plain-English test plan. This is the review point, before any test code exists. The plan lists the records the journey touched, such as `/invoices/inv-1003`, so they can be set up first.
4. **Scaffold.** `scaffold` writes a Playwright test from the reviewed plan. It leaves `// TODO` markers for anything the recording couldn't capture, such as a masked password, and a comment on each step naming the user action it replays.
5. **Finish.** Your coding agent fills in the TODOs and runs the test. It works as a **code-aware agent**: it can read your app's source, so it maps each step to the real control in your code.

A selector is how a test finds a button or field. replaytest takes selectors from the recording, strongest first: `data-testid`, then role and name, then label, then page structure. Weak ones are flagged as guesses, and every made-up value is labelled as a placeholder.

See [How it works](docs/site/how-it-works.md) for the full pipeline and exactly what each test checks.

## ⚙ Install

```bash
npm install --save-dev replaytest
```

Run commands with `npx replaytest <command>` from your repo root.

You'll need:
- **Node.js 22 or newer**, **`@playwright/test` 1.30 or newer**, and the **PostHog CLI** (verified at 0.16.0) on your `PATH`. Runs on macOS and Linux. See the [compatibility table](docs/site/quickstart.md#compatibility).
- **PostHog** (US/EU Cloud or self-hosted) with autocapture on, which is PostHog's automatic capture of clicks and page views. Session replay is recommended: it gives stronger selectors and console-error checks.
- A **read-only PostHog personal API key** with access to queries and session recordings. replaytest never writes to PostHog.

## 🚀 Quickstart

Five steps: `init` → `sessions` → `plan` → `scaffold` → run the test.

**1. Connect your PostHog project.**
```bash
npx replaytest init --project <your-project-id> --token <personal-api-key>
# EU Cloud or self-hosted? add: --host eu.posthog.com  (or your domain)
```
Saves your credentials in `.env` and adds `.env` and `.replaytest/` to `.gitignore`. Credentials are read only from `.env`, never from shell variables.

**2. See the journeys your users take.**
```bash
npx replaytest sessions
```
Lists journeys, most-taken first, with how each one ended and a user id for the next step. More than one site in your PostHog project? See [App scope](docs/site/concepts.md#app-scope).

**3. Turn a journey into a plan.** Use the user id from step 2:
```bash
npx replaytest plan <distinctId>
```
Writes a plain-English plan, which is the review point, and a data file beside it (`<slug>.plan.json`). The slug is the plan's short name.

**4. Write the test scaffold.**
```bash
npx replaytest scaffold <slug>
```
Writes `tests/generated/<slug>.spec.ts`, with `// TODO` markers where something is left to fill in.

**5. Finish and run the test.** Fill in the TODOs, then:
```bash
TARGET_APP_URL=https://staging.your-app.example npx playwright test tests/generated
```
Point `TARGET_APP_URL` at staging or seeded data, never production: generated tests submit real forms. No Playwright config yet? The [Quickstart](docs/site/quickstart.md) has one to copy.

**App behind a login?**
```bash
npx replaytest auth-setup
```
Writes a Playwright login setup file from a recorded login, with marked spots for a test username and password. It never stores credentials or edits your Playwright config. To reuse a saved login instead, set `TARGET_APP_STORAGE_STATE`. See [Recipes](docs/site/recipes.md#apps-that-need-a-login).

**Something looks off?** `npx replaytest doctor` checks what your PostHog project provides. `npx replaytest preflight <slug>` checks that a test's selectors still exist on your app before you run it.

## 🧰 Commands

**Getting tests**

| Command | What it does |
|---|---|
| `init` | Connects your PostHog project and keeps credentials out of git |
| `sessions` | Groups recorded sessions into journeys and ranks them by how many sessions took each one |
| `plan <distinctId>` | Writes a plain-English test plan for each finished journey in one session from that user (choose which with `--session`) |
| `scaffold <slug>` | Writes a Playwright test scaffold from a reviewed plan |
| `auth-setup` | Writes a Playwright login setup file from a recorded login |
| `frames <slug>` | Rebuilds the page and a screenshot at each step from the real recording |
| `gaps` | Lists real traffic that has no known linked test yet |

**Keeping tests working**

| Command | What it does |
|---|---|
| `triage <slug>` | A test that used to pass now fails: checks fresh traffic and says why, whether the page changed, the flow changed, or the journey no longer shows up |
| `heal` | Runs the same check on every failed test from one Playwright run |
| `fix-selector <slug>` | Proposes a fix for a selector that stopped matching, applied only after review |
| `triage --propose` → `diff` → `accept` | When the flow changed: proposes a new plan, shows what would change, and applies it after review |
| `suite-health` | One row per generated test: its last result, and whether its journey still shows up in real traffic |
| `preflight <slug>` | Checks locally, in seconds, that a test's selectors still exist on your app |
| `doctor` | Checks what your PostHog project provides |

A repair never quietly changes what a test checks, and re-generating never overwrites your finished work. Every command and flag: [CLI reference](docs/site/cli-reference.md). The repair workflow: [Recipes](docs/site/recipes.md) and the [coding agent maintenance guide](docs/AGENT-MAINTENANCE-GUIDE.md).

## 📊 Dashboard

```bash
npx replaytest dashboard
```

Opens a local dashboard at `http://127.0.0.1:4319`: your ranked journeys, the gap map, and how each generated test is doing (Planned → Scaffolded → Executed → Passing). It flags journeys with rage clicks or errors and links each one to its recording. Nothing is served beyond `127.0.0.1`. See the [Dashboard guide](docs/site/dashboard-guide.md).

**Just looking?** Open `http://127.0.0.1:4319/demo` to explore every tab on built-in sample data. No PostHog project needed.

## 🔒 Privacy

replaytest runs entirely on your machine: no telemetry, and it talks only to your own PostHog project. Scanned sessions are kept locally, so rankings and the gap map can be re-read offline.

Full details: [Privacy](docs/site/privacy.md).

## 📚 Docs

- [Quickstart](docs/site/quickstart.md) — requirements, install, and the five-step first run.
- [How it works](docs/site/how-it-works.md) — the steps from sessions to tests, and exactly what each test checks.
- [Concepts](docs/site/concepts.md) — the key terms: journeys, plans, the three checks a test makes, and the gap map.
- [CLI reference](docs/site/cli-reference.md) — every command and every flag.
- [Dashboard guide](docs/site/dashboard-guide.md) — a tab-by-tab tour of the local dashboard.
- [For AI agents](docs/site/for-ai-agents.md) — how a coding agent maintains the tests, and the `--json` output it can read.
- [Privacy](docs/site/privacy.md) — what the tool never reads, and what it checks before it writes.
- [Recipes](docs/site/recipes.md) — apps behind a login, write safety, personal data (PII), and keeping your tests working.
- [Coding agent maintenance guide](docs/AGENT-MAINTENANCE-GUIDE.md) — how to repair a test that used to pass and now fails.

## 📄 License

Apache-2.0 — see the `LICENSE` file.
