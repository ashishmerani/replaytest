/** Deterministic source-level child for the watch SIGINT characterization test. */
import { runSessionsWatch } from '../sessions-watch.ts';

const NOW = '2026-08-19T15:00:00.000Z';

await runSessionsWatch(['--watch', '--interval', '15m'], {
  log: (line) => {
    process.stdout.write(`${line}\n`, () => { process.send?.('tick-1'); });
  },
  warn: (line) => { process.stderr.write(`${line}\n`); },
  now: () => new Date(NOW),
  getProviderConfigStatus: () => ({ projectId: 'fixture-project', hasApiKey: true }),
  readAutoCheckSetting: () => '15m',
  readStoredSnapshot: () => undefined,
  runCheck: () => Promise.resolve({ provenance: 'exact', meta: null, sessions: [] }),
});
