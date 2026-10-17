# Test: Invoice confirmation

**Starting point:** /
**Viewport:** 1280×720

## Steps
1. Go to /
2. Click "Pay an invoice" `getByRole('link', { name: 'Pay an invoice' })`
3. Click "Pay this invoice" `getByTestId('pay-invoice')`
4. Fill in the "Name on card" field (placeholder value) `getByRole('textbox', { name: 'Name on card' })`
5. Click "Submit payment" (submits the form) `getByTestId('submit-payment')`

## Expected outcome
- The final URL is /invoice-confirmation.html
- The page shows "Payment Successful"
- No console errors occur (inferred — no replay recording found for this session)
- The session's events witnessed 1 exception during this journey (TypeError) — surfaced, not asserted

## Notes
- Session capture masks and drops sensitive required fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Final page text confirmed across 8 sampled sessions.
- Aggregated across 8 sampled sessions of this journey (8 candidates found; 0 fetch-failures/non-matches).
- Typed input doesn't come through from the recording, so these fills use placeholder values.
