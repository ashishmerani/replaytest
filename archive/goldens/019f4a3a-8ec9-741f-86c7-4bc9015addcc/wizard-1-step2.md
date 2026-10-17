# Test: Step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:15:36.765Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-1
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-1
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Fill in the "Priority" field `getByLabel('Priority')`
4. Fill in the "Age" field (placeholder value) `getByRole('spinbutton', { name: 'Age' })`
5. Click "Next" (submits the form) `getByRole('button', { name: 'Next' })`
6. Fill in the "Department" field `getByLabel('Department')`
7. Fill in the "Contact email" field (placeholder value) `getByRole('textbox', { name: 'Contact email' })`
8. Fill in the "Quantity" field (placeholder value) `getByRole('textbox', { name: 'Quantity' })`
9. Click "Submit" (submits the form) `getByRole('button', { name: 'Submit' })`

## Expected outcome
- The final URL is /flows/wizard-1/step2
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
