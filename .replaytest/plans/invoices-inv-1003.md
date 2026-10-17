# Test: Inv 1003

**Starting point:** /
**Viewport:** 1280×800

## Steps
1. Go to /
2. Click "Invoices" `getByRole('link', { name: 'Invoices' })`
3. Click "View" `getByTestId('view-invoice-inv-1003')`
4. Click "Pay invoice" `getByTestId('pay-invoice-link')`
5. Fill in the "cardName" field (placeholder value) `locator('#card-name')`
6. Fill in the "cardExpiry" field (placeholder value) `locator('#card-expiry')`
7. Fill in the "billingEmail" field (placeholder value) `locator('input').nth(0)`
8. Click "Pay" (submits the form) `getByTestId('pay-invoice')`
9. Click "Confirm payment" `getByTestId('confirm-payment')`
10. Click "Back to invoice" `getByRole('button', { name: 'Back to invoice' })`

## Expected outcome
- The final URL matches /invoices/:id (witnessed: /invoices/inv-1003)
- The page's title is "Acme Ops Console"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive required fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Final-URL pattern confirmed across 5 sampled sessions.
- Final page text confirmed across 5 sampled sessions.
- Aggregated across 5 sampled sessions of this journey (5 candidates found; 0 fetch-failures/non-matches).
- Typed input doesn't come through from the recording, so these fills use placeholder values.
