# Test: Wizard probe done

**Provenance:** source: file archive (archive), archived 2026-07-23T20:38:43.036Z; single-session -- aggregation requires the live corpus

**Starting point:** /wizard-probe-query.html
**Viewport:** 1280×720

## Steps
1. Go to /wizard-probe-query.html
2. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
3. Click "Continue" `getByRole('link', { name: 'Continue' })`
4. Fill in the "Company" field (placeholder value) `getByRole('textbox', { name: 'Company' })`
5. Click "Continue" `getByRole('link', { name: 'Continue' })`
6. Click "Input" `getByRole('checkbox', { name: 'Accept terms' })`
7. Fill in the "Accept terms" field `getByRole('checkbox', { name: 'Accept terms' })`
8. Click "Finish signup" (submits the form) `getByRole('button', { name: 'Finish signup' })`

## Expected outcome
- The final URL is /wizard-probe-done.html
- The page shows "Signup complete"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
