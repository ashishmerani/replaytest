# Test: Appt 6

**Provenance:** source: file archive (archive), archived 2026-07-11T20:03:37.814Z; single-session -- aggregation requires the live corpus

**Starting point:** /appointments
**Viewport:** 1280×720

## Steps
1. Go to /appointments
2. Click "New Appointment" `getByTestId('new-appointment-link')`
3. Fill in the "customerId" field `locator('#appt-customer')`
4. Fill in the "time" field `locator('#appt-time')`
5. Fill in the "title" field (placeholder value) `locator('#appt-title')`
6. Fill in the "notes" field (placeholder value) `locator('#appt-notes')`
7. Click "Create appointment" (submits the form) `getByTestId('create-appointment')`

## Expected outcome
- The final URL is /appointments/appt-6
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
