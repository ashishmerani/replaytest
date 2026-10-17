# Test: Step1

**Provenance:** source: file archive (archive), archived 2026-07-11T19:16:39.245Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows
**Viewport:** 1280×720

## Steps
1. Go to /flows
2. Click "Back to flows" `getByRole('link', { name: 'Back to flows' })`
3. Fill in the "Search query" field (placeholder value) `getByRole('textbox', { name: 'Search query' })`
4. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`

## Expected outcome
- The final URL is /flows/search-1/step1
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- 3 page transitions had no witnessed trigger interaction (/flows/search-3/step2, /flows/search-3/step2, /flows/search-1) — the recording saw the navigation but not the click/input that caused it (autocapture can drop a click when the page unloads quickly). This flow cannot reproduce that hop on its own — add the real navigation step (the control's click, or a direct goto) before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
