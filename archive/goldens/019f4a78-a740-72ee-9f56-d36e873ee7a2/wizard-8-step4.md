# Test: Wizard 8 step4

**Provenance:** source: file archive (archive), archived 2026-07-11T19:35:27.675Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-8-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-8-step1.html
2. Click "Start" `getByRole('link', { name: 'Start' })`
3. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
4. Fill in the "Email address" field (placeholder value) `getByRole('textbox', { name: 'Email address' })`
5. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`
6. Fill in the "Additional note" field (placeholder value) `getByRole('textbox', { name: 'Additional note' })`
7. Fill in the "Email address" field (placeholder value) `getByRole('textbox', { name: 'Email address' })`
8. Click "Finish" (submits the form) `getByRole('button', { name: 'Finish' })`

## Expected outcome
- The final URL is /flows/wizard-8-step4.html
- The page's title is "Wizard 8 — Complete"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
