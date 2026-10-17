import { maybePrintVerbHelp } from '../help.js';

/**
 * `dashboard` verb starts the local dashboard server. `--help`/`-h` is
 * checked FIRST — before the dynamic import, let alone `startServer()` —
 * so `dashboard --help` can never open a socket. The
 * server module is loaded via DYNAMIC import because its module initialization
 * reads a roughly 226 KB asset and builds caches at module scope; plain CLI
 * commands do not need that work. `startServer()` binds 127.0.0.1 and keeps the
 * process alive; it honors `PORT` itself (as the `npm run dashboard` dev
 * script already does). Impure (opens a socket) — live-verified, not
 * unit-tested. The `./dashboard/server.js` specifier resolves to the `.ts`
 * source under tsx (dev) and to the compiled `.js` under plain Node
 * (installed).
 */
export async function runDashboard(argv: string[]): Promise<void> {
  if (maybePrintVerbHelp(argv, 'dashboard')) return;
  const { startServer } = await import('../../dashboard/server.js');
  startServer();
}

