# Test: Step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:56:18.984Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/settings-4
**Viewport:** 1280×720

## Steps
1. Go to /flows/settings-4
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Click "Input" `getByRole('checkbox', { name: 'Agree to terms' })`
4. Fill in the "Agree to terms" field `getByRole('checkbox', { name: 'Agree to terms' })`
5. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`
6. Fill in the "Comments" field (placeholder value) `getByLabel('Comments')`
7. Fill in the "Enable notifications" field `getByRole('checkbox', { name: 'Enable notifications' })`
8. Click "Input" (submits the form) `getByRole('checkbox', { name: 'Enable notifications' })`
9. Click "Save settings" `getByRole('button', { name: 'Save settings' })`

## Expected outcome
- The final URL is /flows/settings-4/step2
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
