# Test: Customer created

**Provenance:** source: file archive (archive), archived 2026-07-11T19:37:33.702Z; single-session -- aggregation requires the live corpus

**Starting point:** /
**Viewport:** 1280×720

## Steps
1. Go to /
2. Click "Add a customer" `getByRole('link', { name: 'Add a customer' })`
3. Fill in the "name" field (placeholder value) `locator('#name')`
4. Fill in the "Email address" field (placeholder value) `getByRole('textbox', { name: 'Email address' })`
5. Fill in the "company" field (placeholder value) `locator('#company')`
6. Click "Create customer" (submits the form) `getByRole('button', { name: 'Create customer' })`

## Expected outcome
- The final URL is /customer-created.html
- The page's title is "Customer Created"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
