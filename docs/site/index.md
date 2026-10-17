# replaytest docs

Your users already show you which flows matter. Every session is recorded in the analytics tool you already run. `replaytest` reads those recorded sessions (PostHog is the only tool supported so far) and turns the journeys your users really take into Playwright regression tests. You don't install a new recorder, and your data goes nowhere beyond your own PostHog project. Your coding agent can run every step, from reading sessions to running the tests.

## Contents

| Page | What's in it |
|---|---|
| [Quickstart](./quickstart.md) | What you need, how to install, and your first run in five steps (`init` → `sessions` → `plan` → `scaffold` → run), from nothing installed to a running generated test. |
| [How it works](./how-it-works.md) | The five stages from recorded session to test, why the plan sits in the middle, and what the tool does not do. |
| [Concepts](./concepts.md) | The words the other pages use: journeys, journey families, plans, Tier-1 assertions (the checks a test makes), the gap map and suite health. |
| [CLI reference](./cli-reference.md) | Every command, its flags, and its real `--help` output. |
| [Dashboard guide](./dashboard-guide.md) | A tab-by-tab walkthrough of the local dashboard: what each badge, ⓘ, and view means. |
| [For AI agents](./for-ai-agents.md) | A guide for the coding agent that keeps your generated tests passing, plus tables of what each command's machine-readable `--json` output contains. |
| [Privacy](./privacy.md) | What the tool never reads, what it checks before it writes, and the limits it states honestly. |
| [Recipes](./recipes.md) | Apps behind a login, running generated tests safely, handling personal data (PII), keeping your generated tests passing, and the tool's current limitations. |

## What this is not

This tool tests your app's user interface, not your whole stack. It repeats the path a real user took, but it does not prove that anything happened in your backend. Its checks cover only what the recording actually showed: the final page address, text that was on the page, and no console errors. It never checks an outcome it had to guess. See [How it works](./how-it-works.md) for the full explanation.
