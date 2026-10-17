# Test: Step2

**Provenance:** source: file archive (archive), archived 2026-07-11T19:39:38.694Z; single-session -- aggregation requires the live corpus

**Starting point:** /flows/feedback-7
**Viewport:** 1280×720

## Steps
1. Go to /flows/feedback-7
2. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
3. Fill in the "Full name" field (placeholder value) `getByRole('textbox', { name: 'Full name' })`
4. Fill in the "Priority" field `getByLabel('Priority')`
5. Fill in the "Work email" field (placeholder value) `getByRole('textbox', { name: 'Work email' })`
6. Fill in the "Age" field (placeholder value) `getByRole('textbox', { name: 'Age' })`
7. Click "Submit feedback" (submits the form) `getByRole('button', { name: 'Submit feedback' })`
8. Click "Input" `locator('[id="__nuxt"] > div:nth-child(1) > main:nth-child(2) > section:nth-child(1) > form:nth-child(2) > div:nth-child(1) > div:nth-child(2) > label:nth-child(1) > input:nth-child(1)')` (positional/text-match locator — can silently target the wrong element; verify it)
9. Fill in the "feedback-7-p1-f0" field (placeholder value) `locator('[id="__nuxt"] > div:nth-child(1) > main:nth-child(2) > section:nth-child(1) > form:nth-child(2) > div:nth-child(1) > div:nth-child(2) > label:nth-child(1) > input:nth-child(1)')` (positional/text-match locator — can silently target the wrong element; verify it)
10. Fill in the "Department" field `getByLabel('Department')`
11. Fill in the "Company name" field (placeholder value) `getByRole('textbox', { name: 'Company name' })`
12. Fill in the "Contact email" field (placeholder value) `getByRole('textbox', { name: 'Contact email' })`
13. Click "Input" `locator('[id="__nuxt"] > div:nth-child(1) > main:nth-child(2) > section:nth-child(1) > form:nth-child(2) > div:nth-child(6) > div:nth-child(2) > label:nth-child(1) > input:nth-child(1)')` (positional/text-match locator — can silently target the wrong element; verify it)
14. Fill in the "Quantity" field (placeholder value) `getByRole('textbox', { name: 'Quantity' })`
15. Fill in the "feedback-7-p1-rating" field (placeholder value) `locator('[id="__nuxt"] > div:nth-child(1) > main:nth-child(2) > section:nth-child(1) > form:nth-child(2) > div:nth-child(6) > div:nth-child(2) > label:nth-child(1) > input:nth-child(1)')` (positional/text-match locator — can silently target the wrong element; verify it)
16. Fill in the "Comments" field (placeholder value) `getByLabel('Comments')`
17. Click "Submit feedback" (submits the form) `getByRole('button', { name: 'Submit feedback' })`

## Expected outcome
- The final URL is /flows/feedback-7/step2
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.
- This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
