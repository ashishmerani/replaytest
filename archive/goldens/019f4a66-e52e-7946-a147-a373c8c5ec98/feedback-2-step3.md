# Test: Step3

**Provenance:** source: file archive (archive), archived 2026-07-11T19:29:11.094Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/feedback-2
**Viewport:** 1280×720

## Steps
1. Go to /flows/feedback-2
2. Fill in the "Age" field (placeholder value) `getByRole('spinbutton', { name: 'Age' })`
3. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
4. Fill in the "Notes" field (placeholder value) `getByLabel('Notes')`
5. Click "Input" `getByRole('checkbox', { name: 'Agree to terms' })`
6. Fill in the "Agree to terms" field `getByRole('checkbox', { name: 'Agree to terms' })`
7. Click "Submit feedback" (submits the form) `getByRole('button', { name: 'Submit feedback' })`
8. Fill in the "feedback-2-p1-f0" field `locator('#feedback-2-1-feedback-2-p1-f0')`
9. Fill in the "feedback-2-p1-f1" field (placeholder value) `locator('#feedback-2-1-feedback-2-p1-f1')`
10. Fill in the "feedback-2-p1-f3" field `locator('#feedback-2-1-feedback-2-p1-f3')`
11. Fill in the "feedback-2-p1-f2" field (placeholder value) `locator('#feedback-2-1-feedback-2-p1-f2')`
12. Click "Input" `locator('#feedback-2-1-feedback-2-p1-f3')`
13. Click "Submit feedback" (submits the form) `getByRole('button', { name: 'Submit feedback' })`
14. Fill in the "feedback-2-p2-f0" field `locator('#feedback-2-2-feedback-2-p2-f0')`
15. Fill in the "feedback-2-p2-f1" field (placeholder value) `locator('#feedback-2-2-feedback-2-p2-f1')`
16. Fill in the "feedback-2-p2-f2" field (placeholder value) `locator('#feedback-2-2-feedback-2-p2-f2')`
17. Fill in the "feedback-2-p2-f3" field `locator('#feedback-2-2-feedback-2-p2-f3')`
18. Click "Input" `locator('#feedback-2-2-feedback-2-p2-f3')`
19. Click "Input" `locator('[id="__nuxt"] > div:nth-child(1) > main:nth-child(2) > section:nth-child(1) > form:nth-child(2) > div:nth-child(5) > div:nth-child(2) > label:nth-child(1) > input:nth-child(1)')` (positional/text-match locator — can silently target the wrong element; verify it)
20. Fill in the "feedback-2-p2-rating" field (placeholder value) `locator('[id="__nuxt"] > div:nth-child(1) > main:nth-child(2) > section:nth-child(1) > form:nth-child(2) > div:nth-child(5) > div:nth-child(2) > label:nth-child(1) > input:nth-child(1)')` (positional/text-match locator — can silently target the wrong element; verify it)
21. Fill in the "feedback-2-p2-feedback_notes" field (placeholder value) `locator('#feedback-2-2-feedback-2-p2-feedback_notes')`
22. Click "Submit feedback" (submits the form) `getByRole('button', { name: 'Submit feedback' })`

## Expected outcome
- The final URL is /flows/feedback-2/step3
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
