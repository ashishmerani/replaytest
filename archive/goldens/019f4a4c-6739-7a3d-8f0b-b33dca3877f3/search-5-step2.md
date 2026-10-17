# Test: Search 5 step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:21:52.119Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/search-5-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/search-5-step1.html
2. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
3. Fill in the "Phone number" field (placeholder value) `getByRole('textbox', { name: 'Phone number' })`
4. Click "Input" `getByRole('radio', { name: 'Mail' })`
5. Fill in the "Mail" field `getByRole('radio', { name: 'Mail' })`
6. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
7. Click "Search" (submits the form) `getByRole('button', { name: 'Search' })`

## Expected outcome
- The final URL is /flows/search-5-step2.html
- The page shows "Search 5 — Results"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
