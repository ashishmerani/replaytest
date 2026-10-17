# Test: Cust 6

**Provenance:** source: file archive (archive), archived 2026-08-22T22:00:46.729Z; single-session -- aggregation requires the live corpus

**Starting point:** /customers
**Viewport:** 1280×720

## Steps
1. Go to /customers
2. Click "Input" `getByTestId('quick-add-customer')`
3. Fill in the "Quick add customer" field (placeholder value) `getByTestId('quick-add-customer')`
4. Press Enter in the "Quick add customer" field to commit the edit — SYNTHESIZED, not witnessed: no provider tier records the committing keystroke (autocapture has no keypress event; session replay records input values, not keys). The landing that follows it in the recording is the evidence the commit happened. Verify Enter is your app's commit mechanic — a blur- or Tab-commit app looks identical in the recording. `getByTestId('quick-add-customer')`

## Expected outcome
- The final URL is /customers/cust-6
- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)

## Notes
- This flow performs writes (it creates a record by committing an inline edit — no form submit was witnessed). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production. It is NOT idempotent: every run creates another new record, and this tool has no cleanup step.
- Step "Quick add customer" presses Enter to commit the edit. SYNTHESIZED, not witnessed: no provider tier records the committing keystroke (autocapture has no keypress event; session replay records input values, not keys). The landing that follows it in the recording is the evidence the commit happened. Verify Enter is your app's commit mechanic — a blur- or Tab-commit app looks identical in the recording.
- This journey was recognized structurally (typed input, then a landing on a new route) — nobody witnessed the intent. Three shapes look identical to a create and would be wrong to keep: searching and opening an existing result; editing a field then leaving for an unrelated reason; and creating something that was deleted again later. Confirm this is really a create before committing the generated spec.
- Triage cannot yet assess this plan: the regression arithmetic scores completed/submitted/abandoned outcomes only, so fresh traffic for this journey reports as insufficient evidence rather than healthy or regressed. Re-check it by hand until that arithmetic covers the navigated class.
- Typed input doesn't come through from the recording, so these fills use placeholder values.
