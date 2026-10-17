# Privacy

This is the project's data-handling commitment.

## Tier 1 — Structural

replaytest never reads your users' typed values when building a plan or test — its provider query and its session-replay reader never select an input's value, enforced structurally and pinned by tests. This is source-field exclusion, not proof that a site cannot display an entered value back as page content. (`replaytest frames` exports raw reconstructed pages and is declared-sensitive by name — never commit or share its output.)

## Tier 2 — Boundary

Everything replaytest writes goes through registered, guarded chokepoints. Text that is PII-shaped — email-, long-number-, or PostHog-project-token-shaped — is detected before rendering and disclosed in the artifact's caveats, never silently removed. Raw third-party diagnostic text (test-runner errors, provider CLI output) is length-bounded and structured; writes of PII-shaped content to your committed test files without a disclosure carrier are stopped until you explicitly allow them.

## Tier 3 — Honesty

What your app shows, replaytest may write. A page that displays a typed value back — in a heading, title, label, or URL path — makes it indistinguishable from ordinary page content; replaytest cannot tell them apart and does not claim to. The detector is shape-based only: it does not recognize names. A clean caveat block means the detectors found nothing — it is not proof that no personal data is present.
