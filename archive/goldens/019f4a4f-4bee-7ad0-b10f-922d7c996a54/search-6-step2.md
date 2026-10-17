# Test: Step2

**Provenance:** source: file archive (archive), archived 2026-07-11T18:59:51.645Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/search-6
**Viewport:** 1280×720

## Steps
1. Go to /flows/search-6
2. Fill in the "Search query" field (placeholder value) `getByTestId('search-6-s1-field-0')`
3. Fill in the "search-6-s1 text field 3" field (placeholder value) `getByTestId('search-6-s1-field-2')`
4. Fill in the "Email address 4" field (placeholder value) `getByTestId('search-6-s1-field-3')`
5. Fill in the "Search query" field (placeholder value) `getByTestId('search-6-s1-field-0')`
6. Click "Search" (submits the form) `getByTestId('search-6-s1-submit')`

## Expected outcome
- The final URL is /flows/search-6/step2
- The page shows "404"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
