# Test: Wizard 4 step3

**Provenance:** source: file archive (archive), archived 2026-07-11T19:21:52.119Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-4-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-4-step1.html
2. Click "Start" `getByRole('link', { name: 'Start' })`
3. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
4. Click "Input" `getByRole('checkbox', { name: 'Subscribe to updates' })`
5. Fill in the "Subscribe to updates" field `getByRole('checkbox', { name: 'Subscribe to updates' })`
6. Click "Finish" (submits the form) `getByRole('button', { name: 'Finish' })`

## Expected outcome
- The final URL is /flows/wizard-4-step3.html
- The page shows "Wizard 4 complete — Corpus User 777"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
