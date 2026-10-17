# Test: Invoice confirmation

**Provenance:** source: file archive (archive), archived 2026-07-11T20:06:48.646Z; single-session -- aggregation requires the live corpus

**Starting point:** /
**Viewport:** 1280×720

## Steps
1. Go to /
2. Click "Pay an invoice" `getByRole('link', { name: 'Pay an invoice' })`
3. Click "Pay this invoice" `getByTestId('pay-invoice')`
4. Fill in the "Name on card" field (placeholder value) `getByRole('textbox', { name: 'Name on card' })`
5. Fill in the "Billing email (for your receipt)" field (placeholder value) `getByRole('textbox', { name: 'Billing email (for your receipt)' })`
6. TODO: masked field not in the recording, supply a test value: `await page.getByLabel('Card number').fill('<supply test value>');` (label inferred from adjacent text — verify the locator resolves)
7. Click "Submit payment" (submits the form) `getByTestId('submit-payment')`

## Expected outcome
- The final URL is /invoice-confirmation.html
- The page shows "Payment Successful"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)
- The session's events witnessed 1 exception during this journey (TypeError) — surfaced, not asserted

## Notes
- Field structure summary: 2 fields with structure captured (Name on card, Billing email (for your receipt)). 1 field masked in the recording and not captured (Card number).
- The recording masked the field "Card number" — if it is required, this submit needs a test value for it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
