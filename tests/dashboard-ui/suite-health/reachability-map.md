# Suite Health reachability map

| Inventory sentence | Current home |
| --- | --- |
| Three times are listed separately: when Suite Health was worked out, when heal last ran, and when your tests last really ran. | Count-line information control, `dashsh-count-framing`. |
| None of your generated tests has a recorded run yet. A passing plan doesn't prove the tests work against your live app — run the suite once to find out. | Latest-result information control and the count-line information control, `dashsh-count-real-run`. |
| No generated specs or plans found yet. Suite Health never infers a green result from an empty workspace. | Empty inventory state. |
| ⓘ couldn't read the generated-tests directory (EACCES) — its inventory is unavailable. | Unreadable inventory state. |
| This result was just recomputed. | Count-line information control, `dashsh-count-computed`. |
| Suite Health was computed [age]. Raw UTC: [utc]. This is a saved result; Re-check now works it out again. | Count-line information control, `dashsh-count-computed`. |
| Failing with no heal result behind it. Run heal to find out what changed. | Row drawer, Latest result section — the row is one line, so the reason a row needs a person lives only here. |
