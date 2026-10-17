# Test: 2

**Provenance:** source: file archive (archive), archived 2026-07-11T18:54:37.839Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/wizard-3
**Viewport:** 1280×720

## Steps
1. Go to /flows/wizard-3
2. Fill in the "Your name" field (placeholder value) `getByTestId('wizard-3-s1-field-0')`
3. Click "Input" `getByTestId('wizard-3-s1-field-2')`
4. Fill in the "Enable option 3" field `getByTestId('wizard-3-s1-field-2')`
5. Fill in the "Additional notes 2" field (placeholder value) `getByTestId('wizard-3-s1-field-1')`
6. Click "Input" `getByRole('radio', { name: 'Choice C' })`
7. Fill in the "Choice C" field `getByRole('radio', { name: 'Choice C' })`
8. Click "Finish" (submits the form) `getByTestId('wizard-3-s1-submit')`

## Expected outcome
- The final URL matches /flows/wizard-3/step/:id (witnessed: /flows/wizard-3/step/2)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
