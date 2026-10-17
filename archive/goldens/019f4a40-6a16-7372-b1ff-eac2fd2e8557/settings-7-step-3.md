# Test: 3

**Provenance:** source: file archive (archive), archived 2026-07-11T19:04:03.293Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/settings-7
**Viewport:** 1280×720

## Steps
1. Go to /flows/settings-7
2. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
3. Fill in the "settings-7-s1 text field 2" field (placeholder value) `getByRole('textbox', { name: 'settings-7-s1 text field 2' })`
4. Fill in the "Choose an option 4" field `getByLabel('Choose an option 4')`
5. Fill in the "Email address 3" field (placeholder value) `getByRole('textbox', { name: 'Email address 3' })`
6. Fill in the "Quantity 5" field (placeholder value) `getByRole('spinbutton', { name: 'Quantity 5' })`
7. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings — Settings 7' })`
8. Fill in the "settings-7-s2 text field 2" field (placeholder value) `getByRole('textbox', { name: 'settings-7-s2 text field 2' })`
9. Fill in the "Choose an option 4" field `getByLabel('Choose an option 4')`
10. Fill in the "Email address 3" field (placeholder value) `getByRole('textbox', { name: 'Email address 3' })`
11. Fill in the "Quantity 5" field (placeholder value) `getByRole('textbox', { name: 'Quantity 5' })`
12. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings — Settings 7' })`

## Expected outcome
- The final URL matches /flows/settings-7/step/:id (witnessed: /flows/settings-7/step/3)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
