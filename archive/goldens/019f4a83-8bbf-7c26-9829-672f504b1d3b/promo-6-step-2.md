# Test: 2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:38:36.588Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/promo-6
**Viewport:** 1280×720

## Steps
1. Go to /flows/promo-6
2. Fill in the "name" field (placeholder value) `locator('#promo-6-s1-f0')`
3. Fill in the "promo-6-s1-email-4" field (placeholder value) `locator('#promo-6-s1-f3')`
4. Fill in the "promo_code" field (placeholder value) `locator('#promo-6-s1-f1')`
5. Fill in the "promo-6-s1-text-3" field (placeholder value) `locator('#promo-6-s1-f2')`
6. Fill in the "promo_code" field (placeholder value) `locator('#promo-6-s1-f1')`
7. Click "Apply code" (submits the form) `getByTestId('promo-6-s1-submit')`

## Expected outcome
- The final URL matches /flows/promo-6/step/:id (witnessed: /flows/promo-6/step/2)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
