# Gap map reachability map

| key | surface | clicks | fixture | expected visible content |
|---|---|---:|---|---|
| GM-1 | on screen | 0 | count-a | What your users actually do that has no test yet, ranked by how many sessions did it. |
| GM-2 | count-line ⓘ | 1 | count-a | Where this comes from: traffic numbers are from your PostHog scan; the 'has a test' check looks at files in this workspace. |
| GM-3 | count-line ⓘ | 1 | count-a | The scan supplies the traffic signals. This workspace supplies your replaytest plans, your generated test files, and a limited look at your existing tests. |
| GM-4 | count-line ⓘ | 1 | count-a | The Gap map reuses the Sessions tab's Journey families / Flat setting — there is no separate Gap map toggle. |
| GM-5 | on screen | 0 | count-a | 3 rows shown · 2 with no test yet · from 55 sessions |
| GM-6 | header ⓘ | 1 | count-a | Confidence says how sure the evidence is. |
| GM-7 | header ⓘ | 1 | count-a | Coverage is one route-level check. ✓ Has a test |
| GM-8 | header ⓘ | 1 | count-a | Next step shows the main action for the row; for a "No test yet" row that comes first. |
| GM-9 | drawer | 1 | count-a | This test will submit form data when it runs. Point it at a staging site or seeded test data — never at production. |
| GM-10 | drawer | 1 | count-a | We couldn't count steps for this row — it needs the detailed scan. |
| GM-11 | drawer | 1 | count-a | This exact row has no single-URL journey-depth evidence. |
| GM-12 | drawer | 1 | count-a | This plan was replaced by a newer one — review the newer plan. |
| GM-13 | on screen | 0 | read-failure | This page couldn't load a Gap map. Re-run the scan and refresh. |
| GM-14 | on screen | 0 | empty-map | The scan found no ranked traffic in this window. |
| GM-15 | on screen | 0 | never-scanned | No Gap map has been saved yet. Check for new sessions to build one. |
| GM-16 | count-line ⓘ | 1 | count-a | What your users actually do — and which of it has no test yet. Rows are ranked by how many user sessions did the same thing; Rank 1 is what users do most. Use the Coverage column to find 'No test yet' rows, copy a row's command, and turn that real journey into a test. |
| GM-17 | spot-check modal | 1 | count-a | We pulled a small sample of your most recent sessions and noted practical facts — screen sizes, logins, errors. |
| GM-18 | spot-check modal | 1 | count-a | This is a bounded newest-first sample, separate from the traffic map above; it never refreshes from this page. |
| GM-19 | count-line ⓘ | 1 | count-a | "No test yet" counts every row that matches your filters — not just this page, and not the whole unfiltered list. |
| GM-20 | count-line ⓘ | 1 | count-a | Filters use each row's overall coverage and confidence. The breakdown by traffic kind is in Details. |
| GM-21 | header ⓘ | 1 | count-a | The pages (routes) this journey visited, in order. Short path trims the list: a start shared by every journey shows once in this header, a long middle folds into +N steps, and the last page always shows. Hover a journey to see its full path; Details always shows it. A page that is not a sub-page of the one before it starts with /, so it reads as a full path rather than as part of the page before. |
