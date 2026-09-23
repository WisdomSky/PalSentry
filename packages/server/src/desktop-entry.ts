import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * True when this file is the process entry point.
 *
 * Electron hands the shell's own switches to the main process, so `process.argv[1]` is often
 * something like `--user-data-dir=C:\Users\...`. Pasting that into a `file://` URL throws
 * "Invalid URL" on Windows, which stopped the embedded server from starting at all, so compare
 * resolved paths and treat anything unreadable as "not the entry point".
 */
export function isEntryPoint(
  entry: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (entry === undefined || entry === '') return false;

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(entry)) {
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
