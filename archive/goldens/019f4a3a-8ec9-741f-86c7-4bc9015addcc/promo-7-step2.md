# Test: Step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:15:36.765Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/promo-7
**Viewport:** 1280×720

## Steps
1. Go to /flows/promo-7
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
4. Fill in the "Work email" field (placeholder value) `getByRole('textbox', { name: 'Work email' })`
5. Fill in the "Priority" field `getByLabel('Priority')`
6. Fill in the "Age" field (placeholder value) `getByRole('spinbutton', { name: 'Age' })`
7. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`
8. Fill in the "Company name" field (placeholder value) `getByRole('textbox', { name: 'Company name' })`
9. Fill in the "Promo code" field (placeholder value) `getByRole('textbox', { name: 'Promo code' })`
10. Fill in the "Department" field `getByLabel('Department')`
11. Fill in the "Contact email" field (placeholder value) `getByRole('textbox', { name: 'Contact email' })`
12. Fill in the "Quantity" field (placeholder value) `getByRole('textbox', { name: 'Quantity' })`
13. Fill in the "Promo code" field (placeholder value) `getByRole('textbox', { name: 'Promo code' })`
14. Click "Apply code" (submits the form) `getByRole('button', { name: 'Apply code' })`

## Expected outcome
- The final URL is /flows/promo-7/step2
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
