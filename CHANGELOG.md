# Changelog

All notable changes to replaytest are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-17

First public release.

replaytest reads your production traffic, sorts it into user journeys, and turns the most common ones into Playwright test scaffolds. Your coding agent gets what it needs to finish them and keep them working: page snapshots from the real recording and a repair skill.

### Added

- `sessions` groups recorded sessions into journeys and ranks them by how many sessions took each one.
- `plan` and `scaffold` write a plain-English test plan, then a Playwright test scaffold from it.
- `frames` rebuilds the page and a screenshot at each step from the real recording.
- `gaps` lists real traffic with no known linked test, such as form submits and rage clicks.
- `triage` and `heal` check fresh traffic and say why a test went red: the page changed, the flow changed, or users stopped taking that path.
- `fix-selector` and `accept` apply a reviewed repair, either a selector patch or a new plan checked with `diff`, and refuse rather than guess.
- A local dashboard for sessions, plans, gaps and suite health.
- `--json` output on the commands your coding agent reads results from, and `explain <code>` for every refusal code.
- The `replaytest-repair` skill and a maintenance guide for your coding agent.
- PostHog is the only supported session source in this release.

[0.1.0]: https://github.com/ashishmerani/replaytest/releases/tag/v0.1.0
