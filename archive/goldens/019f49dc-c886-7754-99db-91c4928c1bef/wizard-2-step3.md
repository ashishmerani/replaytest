# Test: Step3

**Provenance:** source: file archive (archive), archived 2026-07-11T19:52:08.323Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-2
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-2
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Fill in the "Age" field (placeholder value) `getByRole('spinbutton', { name: 'Age' })`
4. Fill in the "Agree to terms" field `getByRole('checkbox', { name: 'Agree to terms' })`
5. Click "Input" `getByRole('checkbox', { name: 'Agree to terms' })`
6. Fill in the "Notes" field (placeholder value) `getByLabel('Notes')`
7. Click "Next" (submits the form) `getByRole('button', { name: 'Next' })`
8. Fill in the "wizard-2-p1-f0" field `locator('#wizard-2-1-wizard-2-p1-f0')`
9. Fill in the "wizard-2-p1-f1" field (placeholder value) `locator('#wizard-2-1-wizard-2-p1-f1')`
10. Fill in the "wizard-2-p1-f2" field (placeholder value) `locator('#wizard-2-1-wizard-2-p1-f2')`
11. Fill in the "wizard-2-p1-f3" field `locator('#wizard-2-1-wizard-2-p1-f3')`
12. Click "Next" `getByRole('button', { name: 'Next' })`
13. Click "Input" (submits the form) `locator('#wizard-2-1-wizard-2-p1-f3')`
14. Fill in the "wizard-2-p2-f0" field `locator('#wizard-2-2-wizard-2-p2-f0')`
15. Fill in the "wizard-2-p2-f1" field (placeholder value) `locator('#wizard-2-2-wizard-2-p2-f1')`
16. Fill in the "wizard-2-p2-f2" field (placeholder value) `locator('#wizard-2-2-wizard-2-p2-f2')`
17. Fill in the "wizard-2-p2-f3" field `locator('#wizard-2-2-wizard-2-p2-f3')`
18. Click "Input" `locator('#wizard-2-2-wizard-2-p2-f3')`
19. Click "Submit" (submits the form) `getByRole('button', { name: 'Submit' })`

## Expected outcome
- The final URL is /flows/wizard-2/step3
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
