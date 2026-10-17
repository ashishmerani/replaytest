# Test: Cust 2968

**Provenance:** source: file archive (archive), archived 2026-07-21T19:12:39.138Z; single-session -- aggregation requires the live corpus

**Starting point:** /
**Viewport:** 1280×720

## Data requirements
Every entity-identified route below was first seen only after a form submit — likely created by the journey itself rather than required in advance:
### First seen after a form submit — likely created by this journey
- `/customers/cust-2968` (pattern `/customers/:id`)

## Steps
1. Go to /
2. Click "Add a customer" `getByRole('link', { name: 'Add a customer' })`
3. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
4. Fill in the "Email address" field (placeholder value) `getByRole('textbox', { name: 'Email address' })`
5. Fill in the "Company" field (placeholder value) `getByRole('textbox', { name: 'Company' })`
6. Click "Create customer" (submits the form) `getByRole('button', { name: 'Create customer' })`

## Expected outcome
- The final URL matches /customers/:id (witnessed: /customers/cust-2968)
- The page shows "Customer Created"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
