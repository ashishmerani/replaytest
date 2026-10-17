# Artifact tabs reachability map

| key | tab | surface | clicks | expected visible content |
|---|---|---|---:|---|
| P-1 | Plans | on screen | 0 | Every reviewable test plan in this workspace — read it, then Scaffold writes the test scaffold. |
| P-2 | Plans | count-line ⓘ | 1 | Every reviewable test plan generated in this workspace — the checkpoint between a real recorded session and a runnable test. |
| P-3 | Plans | count-line ⓘ | 1 | Pick a plan on the left to read exactly what the test will do (Steps) and what it will check (Assertions); when it looks right, Scaffold writes the test scaffold file. |
| P-4 | Plans | count-line ⓘ | 1 | Plans are local files under .replaytest/plans/ — viewing and scaffolding them never contacts PostHog. |
| P-5 | Plans | on screen | 0 | No plans yet — generate one from the Sessions tab. |
| P-6 | Plans | on screen | 0 | We couldn't read your plans folder. Check that .replaytest/plans/ exists and can be read, then try again. |
| P-7 | Plans | detail | 0 | Select a plan on the left to view it. |
| T-1 | Tests | on screen | 0 | The runnable Playwright tests scaffolded in this workspace, exactly as they will run. |
| T-2 | Tests | count-line ⓘ | 1 | The runnable Playwright test scaffolds replaytest has written from your plans. Your coding agent finishes them before you rely on them. |
| T-3 | Tests | count-line ⓘ | 1 | Pick a test on the left to read its source exactly as it will run. |
| T-4 | Tests | count-line ⓘ | 1 | Tests are local files under tests/generated/; viewing them never contacts PostHog. |
| T-5 | Tests | count-line ⓘ | 1 | To create one, start from a plan on the Plans tab. |
| T-6 | Tests | count-line ⓘ | 1 | To see how your tests are faring, use Suite Health. |
| T-7 | Tests | on screen | 0 | No generated tests yet — scaffold one from the Plans tab. |
| T-8 | Tests | on screen | 0 | We couldn't read your generated tests folder. Check that tests/generated/ exists and can be read, then try again. |
| T-9 | Tests | detail | 1 | Could not load this test — the file may have moved or been deleted. Reload the page to refresh the list. |
| T-10 | Tests | detail | 0 | Select a generated test on the left to view its source. |
| R-1 | Retirement records | on screen | 0 | The retirement records stored in this workspace — what was moved, when, and on what evidence. |
| R-2 | Retirement records | count-line ⓘ | 1 | This page lists the retirement records stored in this workspace. Each record shows what was moved, when that decision was recorded, and the evidence it was based on at the time. It is a history, not a live view of your application. |
| R-3 | Retirement records | on screen | 0 | Local retirement records |
| R-4 | Retirement records | count-line ⓘ | 1 | Retirement records are files saved in this workspace when someone retired a journey. They describe what was recorded at retirement only; they do not show the live state of your application or prove that no replacement test exists. |
| R-5 | Retirement records | on screen | 0 | No retirement records are stored in this workspace. |
| R-6 | Retirement records | on screen | 0 | Couldn't read the retirement records folder (permission denied). Records can't be shown until it is readable. |
| R-7 | Retirement records | drawer | 1 | The record lists no moved files. |
| R-8 | Retirement records | on screen | 0 | See what this looks like with demo data |
| R-9 | Retirement records | drawer | 1 | 1 prior retirement record was found for this slug. |
| R-10 | Retirement records | drawer | 1 | Inspect the journal and archive manually before retrying. |
| R-11 | Retirement records | drawer | 1 | Archive path |
| R-12 | Retirement records | drawer | 1 | Record path |
| R-13 | Retirement records | drawer | 1 | Journal path |
