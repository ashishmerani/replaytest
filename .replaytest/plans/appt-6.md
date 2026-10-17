# Test: Appt 6

**Starting point:** /appointments
**Viewport:** 1280×720

## Steps
1. Go to /appointments
2. Fill in the "Customer" field `getByLabel('Customer')`
3. Fill in the "Time" field `getByLabel('Time')`
4. Fill in the "Appointment title" field (placeholder value) `getByRole('textbox', { name: 'Appointment title' })`
5. Fill in the "Notes" field (placeholder value) `getByLabel('Notes')`
6. Click "Create appointment" (submits the form) `getByTestId('create-appointment')`

## Expected outcome
- The final URL is /appointments/appt-6
- The page shows "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive required fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- 1 page transition had no witnessed trigger interaction (/appointments/new) — the recording saw the navigation but not the click/input that caused it (autocapture can drop a click when the page unloads quickly). This flow cannot reproduce that hop on its own — add the real navigation step (the control's click, or a direct goto) before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
