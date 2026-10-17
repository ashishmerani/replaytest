# Test: 2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:32:19.878Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/promo-1
**Viewport:** 1280×720

## Steps
1. Go to /flows/promo-1
2. Fill in the "Choose an option 2" field `getByLabel('Choose an option 2')`
3. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
4. Fill in the "Quantity 3" field (placeholder value) `getByRole('spinbutton', { name: 'Quantity 3' })`
5. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue — Promo 1' })`

## Expected outcome
- The final URL matches /flows/promo-1/step/:id (witnessed: /flows/promo-1/step/2)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
