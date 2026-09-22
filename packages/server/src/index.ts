import { ConfigError, loadConfig } from './config.js';
import { startPalSentry } from './server.js';

/**
 * CLI and container entrypoint.
 *
 * Startup order matters: configuration is validated and reported *before* the logger exists,
 * because a bad `.env` is the single most likely reason this process fails to start and the
 * message needs to be readable in `docker logs` without log formatting.
 *
 * The server itself lives in `server.ts` so the desktop app can embed it without inheriting this
 * file's exit codes and signal handlers.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Plain stderr: the logger is not configured yet and cannot be trusted.
      console.error(`\n  PalSentry cannot start — configuration problem\n\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  let running;
  try {
    running = await startPalSentry({ config });
  } catch (error) {
    // `startPalSentry` has already logged the reason and released the database.
    console.error('Fatal error during startup:', error);
    process.exit(1);
  }

  /**
   * Stop cleanly so Docker's `docker stop` does not have to resort to SIGKILL, which would
   * leave the SQLite WAL unflushed.
   */
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

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
