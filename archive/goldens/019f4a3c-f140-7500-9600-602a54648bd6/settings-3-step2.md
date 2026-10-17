# Test: Settings 3 step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:17:41.484Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/settings-3-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/settings-3-step1.html
2. Fill in the "Your name" field (placeholder value) `getByTestId('settings-3-fld-name')`
3. Fill in the "Comments" field (placeholder value) `getByTestId('settings-3-fld-1')`
4. Click "Input" `getByTestId('settings-3-fld-2')`
5. Fill in the "Subscribe to updates" field `getByTestId('settings-3-fld-2')`
6. Fill in the "Phone number" field (placeholder value) `getByTestId('settings-3-fld-3')`
7. Click "Input" `getByTestId('settings-3-fld-4-2')`
8. Fill in the "Mail" field `getByTestId('settings-3-fld-4-2')`
9. Click "Save settings" (submits the form) `getByTestId('settings-3-submit-1')`

## Expected outcome
- The final URL is /flows/settings-3-step2.html
- The page shows "Settings 3 complete — Corpus User 228"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
