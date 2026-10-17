# Test: Promo 2 step4

**Provenance:** source: file archive (archive), archived 2026-07-11T20:04:40.877Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/promo-2-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/promo-2-step1.html
2. Click "Start" `getByRole('link', { name: 'Start' })`
3. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
4. Fill in the "Quantity" field (placeholder value) `getByRole('spinbutton', { name: 'Quantity' })`
5. Fill in the "Comments" field (placeholder value) `getByLabel('Comments')`
6. Click "Input" `getByRole('checkbox', { name: 'Subscribe to updates' })`
7. Fill in the "Subscribe to updates" field `getByRole('checkbox', { name: 'Subscribe to updates' })`
8. Click "Apply code" (submits the form) `getByRole('button', { name: 'Apply code' })`
9. Fill in the "Promo code" field (placeholder value) `getByRole('textbox', { name: 'Promo code' })`
10. Fill in the "Quantity" field (placeholder value) `getByRole('spinbutton', { name: 'Quantity' })`
11. Fill in the "Comments" field (placeholder value) `getByLabel('Comments')`
12. Click "Input" `getByRole('checkbox', { name: 'Subscribe to updates' })`
13. Fill in the "Subscribe to updates" field `getByRole('checkbox', { name: 'Subscribe to updates' })`
14. Fill in the "Promo code" field (placeholder value) `getByRole('textbox', { name: 'Promo code' })`
15. Click "Apply code" (submits the form) `getByRole('button', { name: 'Apply code' })`

## Expected outcome
- The final URL is /flows/promo-2-step4.html
- The page shows "Promo 2 complete — Corpus User 180"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
