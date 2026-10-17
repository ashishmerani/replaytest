# Test: Feedback 5 step3

**Provenance:** source: file archive (archive), archived 2026-07-11T19:17:41.484Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/search-1-step3.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/search-1-step3.html
2. Click "Start" `getByRole('link', { name: 'Start' })`
3. Fill in the "Your name" field (placeholder value) `getByRole('textbox', { name: 'Your name' })`
4. Fill in the "Phone number" field (placeholder value) `getByRole('textbox', { name: 'Phone number' })`
5. Click "Input" `getByRole('radio', { name: 'Mail' })`
6. Fill in the "Mail" field `getByRole('radio', { name: 'Mail' })`
7. Click "Continue" (submits the form) `getByRole('button', { name: 'Continue' })`

## Expected outcome
- The final URL is /flows/feedback-5-step3.html
- The page shows "Feedback 5"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- 1 page transition had no witnessed trigger interaction (/flows/feedback-5-step1.html) — the recording saw the navigation but not the click/input that caused it (autocapture can drop a click when the page unloads quickly). This flow cannot reproduce that hop on its own — add the real navigation step (the control's click, or a direct goto) before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
