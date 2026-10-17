# Test: Step3

**Provenance:** source: file archive (archive), archived 2026-07-11T18:56:42.668Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-8
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-8
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Fill in the "Work email" field (placeholder value) `getByRole('textbox', { name: 'Work email' })`
4. Click "Next" (submits the form) `getByRole('button', { name: 'Next' })`
5. Fill in the "wizard-8-p1-f0" field (placeholder value) `locator('#wizard-8-1-wizard-8-p1-f0')`
6. Fill in the "wizard-8-p1-f1" field (placeholder value) `locator('#wizard-8-1-wizard-8-p1-f1')`
7. Click "Next" (submits the form) `getByRole('button', { name: 'Next' })`
8. Fill in the "wizard-8-p2-f0" field (placeholder value) `locator('#wizard-8-2-wizard-8-p2-f0')`
9. Fill in the "wizard-8-p2-f1" field (placeholder value) `locator('#wizard-8-2-wizard-8-p2-f1')`
10. Click "Submit" (submits the form) `getByRole('button', { name: 'Submit' })`

## Expected outcome
- The final URL is /flows/wizard-8/step3
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
