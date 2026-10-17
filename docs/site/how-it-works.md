# How it works

You already record how real people use your app, through a session-replay tool such as PostHog. `replaytest` turns those real sessions into regression tests you can run and keep up to date. It reads the recorded sessions, converts them into one common format, and groups them into user journeys: the paths people really took through your app, ranked by how many sessions took each. For the journeys your coding agent picks, it writes a plain-English test plan that your coding agent can read, then generates a Playwright test scaffold from that plan. The test checks only what the recording actually showed. You don't write tests from scratch or guess what users do: your tests come from what they did.

- **Your most common journeys come first** — journeys are ranked by how many sessions took each, so testing starts with what people really do, not a guess.
- **Nothing new to install in your app** — it reuses the PostHog session recordings you already collect, including PostHog's automatic capture of clicks, form submits and page views.
- **Reviewable and repeatable** — each test starts from a plain-English Markdown plan that your coding agent reads and approves, not a black-box guess. The same recording gives the same plan every time.
- **Says what it couldn't know** — it checks only what a session actually showed, tells you what it couldn't recover, and never overwrites your finished work.
- **Bring your own AI coding agent** — the test scaffold comes with `// TODO` markers and notes written so that a coding agent that can read your app's code can finish what the recording couldn't capture.

## The pipeline

Five stages, one flow:

```
1. Recorded session (PostHog)
          ↓
2. One common format → grouped into user journeys,
   ranked by how many sessions took each
          ↓
3. Test plan (Markdown, your coding agent reviews)
          ↓
4. Playwright test scaffold (.spec.ts)
          ↓
5. Your coding agent finishes the test → passing test
```

1. **Recorded sessions.** Real, recorded visits by real users are the raw material. PostHog is the only tool supported today. Other session-replay tools are not supported yet.
2. **One common format, then user journeys.** First, each recorded session is converted into one neutral format that doesn't use PostHog's field names. Then `replaytest` groups sessions that took the same route through your app into a single user journey, and ranks the journeys by how many sessions took each. For example, "243 sessions did entry → form → confirmation" is one row, not 243. Sessions count as the same journey when they visit the same pages in the same order, treating record ids in an address as one pattern: `/invoices/inv-1003` and `/invoices/inv-2041` both read as `/invoices/:id`. Each journey is also labelled with how far the recording showed it got. Everything after this step, including selector recommendations and test checks, reads only this neutral format and knows nothing about PostHog's field names. `replaytest sessions` shows the ranked list; see [Concepts](./concepts.md#journeys-and-canonical-journeys) for the details.
3. **Test plan (Markdown, your coding agent reviews).** The plan is the centre of the whole process, and the point where your coding agent reviews the work. For one journey it lists the steps; the selector it recommends for each step (how the test will find that element on the page) and where that selector came from; the checks the test will make (called Tier-1 assertions, explained below); and every caveat the recording forced, such as masked (hidden) fields, kinds of input the recording doesn't capture, and JavaScript errors the session showed. **Your coding agent should read the plan before the test scaffold is created — it's cheaper to fix a wrong step in plain English than in code.**
4. **Playwright test scaffold (`.spec.ts`).** The `scaffold` command writes this file itself, using `replaytest`'s own built-in generator, from the data file of the plan that your coding agent reviewed. The generator is deterministic: the same plan data always gives the same test scaffold. The file opens with a short comment saying what the draft is and what is unfinished, then marks anything the recording couldn't fully capture with `// TODO`.
5. **Your coding agent finishes the test.** Fill in masked values, set up login if the flow needs it, and resolve anything else the test scaffold flags. See [For AI agents](./for-ai-agents.md).

To find each element, `replaytest` works down a list of options, strongest first: `data-testid`, then role + accessible name, then label, placeholder, id, text, and finally page structure. It takes these from the recording itself, and adds detail from the page snapshot that session replay saved, when there is one. So the more your app exposes, the better the selectors. The weakest options are labelled as guesses in the plan, in its data file (the plan's `.plan.json`), and in the `// TODO` comments in the generated test. Typed input doesn't come through from the recording, so every typed value the tool supplies is labelled as a placeholder value.

> **Why this order?** Playwright's own advice for hand-written tests is to find elements the way a user would: by role and accessible name. It treats `data-testid` as the fallback for when the visible text keeps changing. Selectors in `replaytest` aren't hand-written; they're recovered from a recording. A `data-testid` seen in the recording is the one anchor the app's authors put there on purpose for tools, so it goes first. Role + accessible name comes next, then the remaining options in order of how reliable the recorded evidence is. The weakest two are labelled as guesses in the plan, its data file and the test's `// TODO` comments, rather than passed off as reliable. Testing Library, a popular testing toolkit, ranks test ids last for the same user-first reason. Putting them first is deliberate, and it applies only to selectors recovered from a recording.

## Tier-1 assertions only

Every generated test makes only Tier-1 assertions (checks) on facts the session directly showed. There are three: the final URL reached, expected text present on the page, and no console errors. The tool prefers stable checks over values that change (timestamps, generated ids, changing totals), and never guesses at a meaning the recording didn't actually observe. This limit is deliberate, not a gap: every check can be traced back to something the recording proves.

## What this is not

- **It doesn't test your backend.** The tests replay the path through your screens; they do not prove backend side effects occurred (for example, that an order was saved). This is a tool for catching UI-flow regressions, not full-stack end-to-end testing.
- **No guessing at meaning.** Only Tier-1 checks: the tool checks what the recording showed, never an outcome it inferred, such as "the payment succeeded" or "the order total is correct".
- **PostHog only, today.** No other session-replay or analytics tool is supported yet.
- **Masked inputs stay masked.** Passwords, card numbers, and anything else PostHog hides by default are never captured, so the tool cannot know those values. You get a test scaffold that runs, with real selectors and real steps, a placeholder label on every typed value the tool supplies, and clear markers for what still needs filling in.

For the full privacy promise, including what the tool does and does not do with your data and personal information, see [Privacy](./privacy.md). For step-by-step guides to common tasks, see [Recipes](./recipes.md). For what journeys, plans and the gap map are, and how they fit together, see [Concepts](./concepts.md).
