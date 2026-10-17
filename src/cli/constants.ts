// True leaf by design: this file imports nothing, and the existing domain→CLI
// edges onto it (accept.ts / heal.ts / provider-config.ts / selector-apply.ts
// import TOOL_NAME; heal.ts / diagnostic-bound.ts import the report command)
// are accepted and intentional — these constants do not move to a domain home.

/** The single shared home for the replaytest CLI name. */
export const TOOL_NAME = 'replaytest';

/** A user's Playwright command for writing the JSON report that `heal` reads. */
export const HEAL_PLAYWRIGHT_JSON_COMMAND =
  'PLAYWRIGHT_JSON_OUTPUT_NAME=.replaytest/last-run.json ./node_modules/.bin/playwright test tests/generated --reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js';

export const DEFAULT_PLAN_SAMPLE = 8;
export const MAX_PLAN_SAMPLE = 20;

/** Hard candidate ceiling for a scoped newest-session sample; never proportional to project size. The bounded depth for a scoped gaps sample before it names the actual checked count. */
export const SCOPED_GAPS_SAMPLE_DEPTH_CEILING = 250;
