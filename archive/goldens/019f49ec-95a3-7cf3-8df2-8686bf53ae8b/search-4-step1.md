# Test: Step1

**Provenance:** source: file archive (archive), archived 2026-07-11T18:50:41.389Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/search-4
**Viewport:** 1280×720

## Steps
1. Go to /flows/search-4
2. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
3. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`

## Expected outcome
- The final URL is /flows/search-4/step1
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
