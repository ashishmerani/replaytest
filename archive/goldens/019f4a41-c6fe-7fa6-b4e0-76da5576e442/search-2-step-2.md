# Test: 2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:18:44.700Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/search-2
**Viewport:** 1280×720

## Steps
1. Go to /flows/search-2
2. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
3. Fill in the "Quantity 2" field (placeholder value) `getByRole('spinbutton', { name: 'Quantity 2' })`
4. Fill in the "Additional notes 3" field (placeholder value) `getByLabel('Additional notes 3')`
5. Fill in the "Enable option 4" field `getByRole('checkbox', { name: 'Enable option 4' })`
6. Click "Input" `getByRole('checkbox', { name: 'Enable option 4' })`
7. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
8. Click "Search" (submits the form) `getByRole('button', { name: 'Search' })`

## Expected outcome
- The final URL matches /flows/search-2/step/:id (witnessed: /flows/search-2/step/2)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
