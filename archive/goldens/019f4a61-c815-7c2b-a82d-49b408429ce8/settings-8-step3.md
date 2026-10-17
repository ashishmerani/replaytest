# Test: Step3

**Provenance:** source: file archive (archive), archived 2026-07-11T19:39:38.694Z; single-session -- aggregation requires the live corpus

**Starting point:** /customers/new
**Viewport:** 1280×720

## Steps
1. Go to /customers/new
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Fill in the "Work email" field (placeholder value) `getByRole('textbox', { name: 'Work email' })`
4. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`
5. Fill in the "settings-8-p1-f0" field (placeholder value) `locator('#settings-8-1-settings-8-p1-f0')`
6. Fill in the "settings-8-p1-f1" field (placeholder value) `locator('#settings-8-1-settings-8-p1-f1')`
7. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`
8. Fill in the "settings-8-p2-f0" field (placeholder value) `locator('#settings-8-2-settings-8-p2-f0')`
9. Fill in the "settings-8-p2-f1" field (placeholder value) `locator('#settings-8-2-settings-8-p2-f1')`
10. Click "Save settings" (submits the form) `getByRole('button', { name: 'Save settings' })`

## Expected outcome
- The final URL is /flows/settings-8/step3
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- 1 page transition had no witnessed trigger interaction (/flows/settings-8) — the recording saw the navigation but not the click/input that caused it (autocapture can drop a click when the page unloads quickly). This flow cannot reproduce that hop on its own — add the real navigation step (the control's click, or a direct goto) before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
