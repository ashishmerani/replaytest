# Test: Search 1 step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:37:33.702Z; single-session -- aggregation requires the live corpus

**Starting point:** /
**Viewport:** 1280×720

## Steps
1. Go to /
2. Click "Pay an invoice" `getByRole('link', { name: 'Pay an invoice' })`
3. Click "Pay this invoice" `getByTestId('pay-invoice')`
4. Fill in the "Category" field `getByLabel('Category')`
5. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
6. Fill in the "Quantity" field (placeholder value) `getByRole('textbox', { name: 'Quantity' })`
7. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
8. Click "Search" (submits the form) `getByRole('button', { name: 'Search' })`

## Expected outcome
- The final URL is /flows/search-1-step2.html
- The page's title is "Search 1 — Results"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)
- The session's events witnessed 1 exception during this journey (TypeError) — surfaced, not asserted

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- 7 page transitions had no witnessed trigger interaction (/flows/feedback-1-step1.html, /flows/feedback-1-step2.html, /flows/feedback-1-step3.html, /flows/promo-2-step1.html, /flows/promo-2-step2.html, /flows/promo-2-step3.html, /flows/search-1-step1.html) — the recording saw the navigation but not the click/input that caused it (autocapture can drop a click when the page unloads quickly). This flow cannot reproduce that hop on its own — add the real navigation step (the control's click, or a direct goto) before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
