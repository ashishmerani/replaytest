# Test: Cust 6

**Provenance:** source: file archive (archive), archived 2026-07-11T19:59:27.885Z; single-session -- aggregation requires the live corpus

**Starting point:** /customers
**Viewport:** 1280×720

## Steps
1. Go to /customers
2. Click "New Customer" `getByTestId('new-customer-link')`
3. Fill in the "name" field (placeholder value) `locator('#customer-name')`
4. Fill in the "email" field (placeholder value) `locator('#customer-email')`
5. Fill in the "phone" field (placeholder value) `locator('#customer-phone')`
6. Fill in the "address" field (placeholder value) `locator('#customer-address')`
7. Click "Create Customer" (submits the form) `getByTestId('create-customer')`
8. Click "Confirm" `getByTestId('confirm-create-customer')`

## Expected outcome
- The final URL is /customers/cust-6
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
