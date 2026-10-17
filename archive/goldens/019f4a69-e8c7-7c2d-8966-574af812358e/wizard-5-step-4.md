# Test: 4

**Provenance:** source: file archive (archive), archived 2026-07-11T19:31:17.760Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-5

## Steps
1. Go to /flows/wizard-5
2. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
3. Fill in the "Phone number 2" field (placeholder value) `getByRole('textbox', { name: 'Phone number 2' })`
4. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`
5. Click "Input" `locator('#wizard-5-s2-f0')`
6. Fill in the "wizard-5-s2-checkbox-1" field `locator('#wizard-5-s2-f0')`
7. Fill in the "wizard-5-s2-tel-2" field (placeholder value) `locator('#wizard-5-s2-f1')`
8. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`
9. Click "Input" `locator('#wizard-5-s3-f0')`
10. Fill in the "wizard-5-s3-checkbox-1" field `locator('#wizard-5-s3-f0')`
11. Fill in the "wizard-5-s3-tel-2" field (placeholder value) `locator('#wizard-5-s3-f1')`
12. Click "Finish" (submits the form) `getByRole('button', { name: 'Finish' })`

## Expected outcome
- The final URL matches /flows/wizard-5/step/:id (witnessed: /flows/wizard-5/step/4)
- The page's title is "pipes"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
