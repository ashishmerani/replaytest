# Test: Feedback 3 step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:21:52.119Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/feedback-3-step1.html
**Viewport:** 1280×720

## Steps
1. Go to /flows/feedback-3-step1.html
2. Fill in the "Your name" field (placeholder value) `getByTestId('feedback-3-fld-name')`
3. Click "Input" `getByTestId('feedback-3-fld-rating-4')`
4. Fill in the "5" field `getByTestId('feedback-3-fld-rating-4')`
5. Fill in the "Your feedback" field (placeholder value) `getByTestId('feedback-3-fld-comments')`
6. Fill in the "Phone number" field (placeholder value) `getByTestId('feedback-3-fld-3')`
7. Click "Input" `getByTestId('feedback-3-fld-4-2')`
8. Fill in the "Mail" field `getByTestId('feedback-3-fld-4-2')`
9. Click "Submit feedback" (submits the form) `getByTestId('feedback-3-submit-1')`

## Expected outcome
- The final URL is /flows/feedback-3-step2.html
- The page shows "Feedback 3 complete — Corpus User 777"
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- The asserted page text comes from one session — verify it is not user-specific before relying on it.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
