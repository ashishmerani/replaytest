# Test: Invoice confirmation

**Provenance:** source: file archive (archive), archived 2026-07-11T19:46:55.868Z; single-session -- aggregation requires the live corpus

**Starting point:** /index.html
**Viewport:** 1280×720

## Steps
1. Go to /index.html
2. Click "Pay an invoice" `getByRole('link', { name: 'Pay an invoice' })`
3. Click "Pay this invoice" `getByRole('link', { name: 'Pay this invoice' })`
4. Fill in the "Name on card" field (placeholder value) `getByRole('textbox', { name: 'Name on card' })`
5. TODO: masked field not in the recording, supply a test value: `await page.getByLabel('Card number').fill('<supply test value>');` (label inferred from adjacent text — verify the locator resolves)
6. Click "Submit payment" (submits the form) `getByRole('button', { name: 'Submit payment' })`

## Expected outcome
- The final URL is /invoice-confirmation.html
- The page shows "Payment Successful"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Field structure summary: 1 field with structure captured (Name on card). 1 field masked in the recording and not captured (Card number).
- The recording masked the field "Card number" — if it is required, this submit needs a test value for it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
