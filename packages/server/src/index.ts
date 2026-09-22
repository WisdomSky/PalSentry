import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { closeContext, createContext } from './context.js';
import { createLogger } from './logger.js';

/**
 * Process entrypoint.
 *
 * Startup order matters: configuration is validated and reported *before* the logger exists,
 * because a bad `.env` is the single most likely reason this process fails to start and the
 * message needs to be readable in `docker logs` without log formatting.
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

  const logger = createLogger({ level: config.logLevel, pretty: config.logPretty });

  for (const warning of config.warnings) {
    logger.warn(warning);
  }

  const ctx = createContext(config, logger);

  logger.info(
    {
      version: config.nodeEnv,
      palworldApi: config.palworld.apiBaseUrl,
      destructiveActions: config.allowDestructive ? 'enabled' : 'disabled',
      database: config.dbPath,
      mapMode: config.map.layers.palpagos.textureUrl === null ? 'interactive grids' : 'textures',
      mapTextures: {
        palpagos: config.map.layers.palpagos.textureUrl,
        worldTree: config.map.layers.worldTree.textureUrl,
      },
      mapProjection: config.map.projection,
    },
    'PalSentry starting',
  );

  const app = await buildApp(ctx);

  // Start sampling only in the real entrypoint, never in `buildApp`, so tests do not acquire
  // background timers that keep the process alive. All three run concurrently: metrics and the
  // player read are independent requests, and the recording timer must not wait on either.
  await Promise.all([ctx.metrics.start(), ctx.playerHistory.start()]);

  /**
   * Stop cleanly so Docker's `docker stop` does not have to resort to SIGKILL, which would
   * leave the SQLite WAL unflushed.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    try {
      await app.close();
    } catch (error) {
      logger.error({ err: error }, 'Error while closing the HTTP server');
    }

    await closeContext(ctx);
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    logger.error({ err: error }, 'Failed to bind the HTTP port');
    await closeContext(ctx);
    process.exit(1);
  }

  if (config.allowDestructive) {
    logger.warn(
      'Destructive actions are enabled. Never expose PalSentry directly to the public internet — ' +
        'put it behind a VPN or an authenticating reverse proxy.',
    );
  }

  logger.info(
    { url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}` },
    'PalSentry is ready',
  );
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
