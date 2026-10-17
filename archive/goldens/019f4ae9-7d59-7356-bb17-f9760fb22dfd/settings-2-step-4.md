# Test: 4

**Provenance:** source: file archive (archive), archived 2026-07-11T20:01:33.068Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/feedback-1
**Viewport:** 1280×720

## Steps
1. Go to /flows/feedback-1
2. Fill in the "Choose an option 2" field `getByLabel('Choose an option 2')`
3. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
4. Fill in the "Quantity 3" field (placeholder value) `getByRole('textbox', { name: 'Quantity 3' })`
5. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
6. Fill in the "Quantity 2" field (placeholder value) `getByRole('spinbutton', { name: 'Quantity 2' })`
7. Fill in the "Additional notes 3" field (placeholder value) `getByLabel('Additional notes 3')`
8. Click "Input" `getByRole('checkbox', { name: 'Enable option 4' })`
9. Fill in the "Enable option 4" field `getByRole('checkbox', { name: 'Enable option 4' })`
10. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`
11. Fill in the "settings-2-s2-select-1" field `locator('#settings-2-s2-f0')`
12. Fill in the "settings-2-s2-number-2" field (placeholder value) `locator('#settings-2-s2-f1')`
13. Fill in the "settings-2-s2-notes-3" field (placeholder value) `locator('#settings-2-s2-f2')`
14. Click "Input" `locator('#settings-2-s2-f3')`
15. Fill in the "settings-2-s2-checkbox-4" field `locator('#settings-2-s2-f3')`
16. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`
17. Fill in the "settings-2-s3-select-1" field `locator('#settings-2-s3-f0')`
18. Fill in the "settings-2-s3-number-2" field (placeholder value) `locator('#settings-2-s3-f1')`
19. Fill in the "settings-2-s3-notes-3" field (placeholder value) `locator('#settings-2-s3-f2')`
20. Click "Input" `locator('#settings-2-s3-f3')`
21. Fill in the "settings-2-s3-checkbox-4" field `locator('#settings-2-s3-f3')`
22. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`

## Expected outcome
- The final URL matches /flows/settings-2/step/:id (witnessed: /flows/settings-2/step/4)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
