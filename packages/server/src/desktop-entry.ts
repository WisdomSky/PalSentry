import { startPalSentry } from './server.js';

/**
 * Runnable entry for the embedded server bundle.
 *
 * The desktop package imports `startPalSentry` from the bundle this file produces. Running the
 * same file directly starts the server, which makes the artifact smoke-testable on its own:
 *
 * ```sh
 * PALSENTRY_DESKTOP=1 PALSENTRY_HOST=127.0.0.1 PALSENTRY_PORT=0 node dist/desktop/server.js
 * ```
 *
 * The guard matters: when Electron imports this module the process entry point is the Electron
 * app, not this file, so nothing starts until the shell asks for it.
 */
export { startPalSentry } from './server.js';
export type { RunningPalSentry, StartPalSentryOptions } from './server.js';
// The desktop shell builds the same logger the server uses, so the app's JSON logs land in one
// file with the same redaction rules.
export { createLogger } from './logger.js';
export type { Logger, LoggerSetup } from './logger.js';

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === new URL(`file://${entry}`).href;

if (isMain) {
  const running = await startPalSentry();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    running.logger.info({ signal }, 'Shutting down');
    await running.close();
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}
