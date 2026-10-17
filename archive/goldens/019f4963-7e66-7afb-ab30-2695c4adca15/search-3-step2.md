# Test: Search 3 step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:50:03.464Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-6-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-6-step1.html
2. Fill in the "Full name" field (placeholder value) `getByTestId('wizard-6-fld-name')`
3. Click "Input" `getByTestId('wizard-6-fld-1-2')`
4. Fill in the "Mail" field `getByTestId('wizard-6-fld-1-2')`
5. Fill in the "Additional note" field (placeholder value) `getByTestId('wizard-6-fld-2')`
6. Fill in the "Email address" field (placeholder value) `getByTestId('wizard-6-fld-3')`
7. Fill in the "Search query" field (placeholder value) `getByTestId('search-3-fld-query')`
8. Fill in the "Comments" field (placeholder value) `getByTestId('search-3-fld-1')`
9. Fill in the "Subscribe to updates" field `getByTestId('search-3-fld-2')`
10. Click "Input" `getByTestId('search-3-fld-2')`
11. Fill in the "Phone number" field (placeholder value) `getByTestId('search-3-fld-3')`
12. Click "Input" `getByTestId('search-3-fld-4-2')`
13. Fill in the "Mail" field `getByTestId('search-3-fld-4-2')`
14. Fill in the "Search query" field (placeholder value) `getByTestId('search-3-fld-query')`
15. Click "Search" (submits the form) `getByTestId('search-3-submit')`

## Expected outcome
- The final URL is /flows/search-3-step2.html
- The page's title is "Search 3 — Complete"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
