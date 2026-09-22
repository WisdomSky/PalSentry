import { buildApp } from './app.js';
import { type AppConfig, loadConfig } from './config.js';
import { closeContext, createContext, type AppContext } from './context.js';
import { createLogger, type Logger } from './logger.js';

/**
 * Embeddable server entrypoint.
 *
 * `index.ts` is the CLI/Docker entrypoint: it owns signal handlers and exit codes. This module is
 * the same server as a library, so an embedder — the Electron shell — can start and stop it inside
 * its own process without the process-wide side effects that would end the host application.
 *
 * Nothing here calls `process.exit`, and nothing installs signal handlers: the caller decides what
 * a failure means.
 */

export interface StartPalSentryOptions {
  /** Pre-loaded configuration. Defaults to `loadConfig()`. */
  config?: AppConfig;
  /** Pre-built logger, e.g. one writing to a file. Defaults to the config's stdout logger. */
  logger?: Logger;
  /**
   * Start the metric and Wayback samplers.
   *
   * Defaults to `true`, which is right for a server that boots fully configured. The desktop app
   * passes `false` when it has no connection yet and starts them itself once the user connects.
   */
  startSamplers?: boolean;
}

export interface RunningPalSentry {
  config: AppConfig;
  logger: Logger;
  ctx: AppContext;
  /**
   * The Fastify instance.
   *
   * The type is inferred rather than annotated as `FastifyInstance`: `buildApp` passes our pino
   * logger as `loggerInstance`, which specialises the instance on pino's `Logger`, and that is not
   * assignable to the default `FastifyBaseLogger` parameterisation.
   */
  app: Awaited<ReturnType<typeof buildApp>>;
  /** Base URL the server is listening on, e.g. `http://127.0.0.1:43100`. */
  url: string;
  /** Stop sampling, close the HTTP listener and close SQLite. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Build and start PalSentry, resolving once it is listening.
 *
 * Configuration is validated before the logger exists — a bad `.env` is the most likely reason
 * this fails to start, and the message has to be readable. Callers that need to render that
 * failure themselves (`index.ts` prints it to stderr) load the config first and pass it in.
 */
export async function startPalSentry(
  options: StartPalSentryOptions = {},
): Promise<RunningPalSentry> {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, pretty: config.logPretty });

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

  // Sampling is started here rather than in `buildApp` so tests never acquire background timers
  // that keep the process alive. Metrics and the player read are independent requests, so they run
  // concurrently.
  if (options.startSamplers ?? true) {
    await Promise.all([ctx.metrics.start(), ctx.playerHistory.start()]);
  }

  // Desktop mode is loopback-only and unauthenticated by design, so the exposure warning and the
  // bind-failure hint belong to the container path only.
  if (config.allowDestructive && !config.desktop.enabled) {
    logger.warn(
      'Destructive actions are enabled. Never expose PalSentry directly to the public internet — ' +
        'put it behind a VPN or an authenticating reverse proxy.',
    );
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    logger.error({ err: error }, 'Failed to bind the HTTP port');
    await closeContext(ctx);
    throw error;
  }

  // Report the port actually bound, which differs from `config.port` when 0 was requested.
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;

  logger.info({ url }, 'PalSentry is ready');

  let closed = false;
  return {
    config,
    logger,
    ctx,
    app,
    url,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;

      try {
        await app.close();
      } catch (error) {
        logger.error({ err: error }, 'Error while closing the HTTP server');
      }

      await closeContext(ctx);
    },
  };
}
