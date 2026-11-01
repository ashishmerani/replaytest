# Changelog

All notable changes to replaytest are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-01

### Changed

- Journeys now follow the visit. A page change after more than two minutes away, or any step after more than ten minutes, starts a new visit, so a test no longer begins inside an earlier, unrelated flow.
- Moving on to the next numbered step of the same flow keeps it one journey, so a test no longer stops halfway.
- A journey that submitted one step of a multi-step flow and stopped on the next now reads "Stopped mid-flow", with "(at step N)" when the address carries the step number. It can still be planned; the plan says it checks the step change, not the whole flow.
- The Sessions scan reads events only, so a completed journey there reads "Completed · finish not checked".
- When `plan` reads a session's recording, a journey whose recording shows an error after the last submit, with the form still on the page or shown again with the error, reads "Error after submit" and is skipped with the reason.
- A completed journey reads "finish checked" only when the recording shows the moment after the last submit in full and the final page settling, with no form left open and no error.
- Evidence from a recording is used only when the recording's pages line up one to one with the session's events. Otherwise it is left out, never guessed. Recording evidence can only make a journey less ready for a test, never more.
- The Sessions scan shows "at least N stopped mid-flow" when there are any, because the recording can find more, and shows nothing for it when there are none. It leaves out counts it cannot measure.
- If any line of a session's recording cannot be read, `frames` now draws no pictures for that session and says why, because the unreadable line could belong to any part of the recording. Earlier versions skipped the line and drew the rest.

### Upgrade note

- The Plans need review card, the Sessions tab, `sessions`, and `suite-status` now also list plans built by an earlier version of replaytest, which grouped visits differently. Tests still run unchanged, but some journeys those plans covered may say `No test yet` until those plans are re-run. Re-run `plan` for each listed session. Re-running `plan` rewrites the plan, so edits made to it are replaced. If `plan` refuses because the new rules split or join the journey differently, it writes nothing for that session and says why. Add `--force`, which lets that run overwrite every plan it writes; earlier plans the new rules no longer produce stay in place, and `reconcile --apply` sets them aside. If the session can no longer be fetched, run `regenerate`, then `accept`. If the journey no longer appears in your traffic, `retire` can set the plan and its test aside. When a re-run changes a plan, its test may need to be scaffolded again.

### Fixed

- `frames` now applies page changes the recording stored compressed, so each picture, including the last one, shows what the user saw. When a picture can't be drawn at all, the capture is marked `not-renderable` with the reason, no empty files are written, and the command prints a warning. When only the page or only the screenshot could be drawn, the capture is marked `partial`, only the file that was drawn is saved, and the command says how many captures were only partly drawn. The command's summary line now counts only captures that saved a picture and says so plainly when none did; it also warns when captures were not drawn because the journey matched more than one recorded window, and the frame sensitivity warning appears only when a picture was saved. A `--steps` range outside the journey now refuses with exit code 1 instead of writing an empty manifest, and a screenshot taken when the page could not be read keeps its own file instead of sharing a neighboring one.
- `gaps` and the Gap map no longer suggest `plan` for Submitted or Abandoned journeys, which `plan` refuses; those rows now say why they can't be planned.

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

[0.2.0]: https://github.com/ashishmerani/replaytest/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ashishmerani/replaytest/releases/tag/v0.1.0
