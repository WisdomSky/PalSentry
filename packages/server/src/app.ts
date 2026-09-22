import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import type { AppContext } from './context.js';
import { errorBody, toErrorResponse } from './http/errors.js';
import { protectedApiRoutes, publicApiRoutes } from './routes/index.js';

/** Locate the built SPA, if it exists. Returns null in dev (Vite serves it instead). */
function findWebDist(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/**
 * Assemble the Fastify application.
 *
 * Split from `index.ts` so tests can build an app around a stubbed Palworld server and drive it
 * with `app.inject()` — no real port, no real network.
 *
 * The return type is intentionally inferred: passing our pino instance as `loggerInstance`
 * specialises `FastifyInstance` on pino's `Logger`, which is not assignable to the default
 * `FastifyBaseLogger` parameterisation.
 */
export async function buildApp(ctx: AppContext) {
  const { config, logger } = ctx;

  const app = Fastify({
    loggerInstance: logger,
    // Required for `request.ip` (and therefore audit attribution) to reflect the real client
    // rather than the proxy when PalSentry runs behind one.
    trustProxy: config.auth.secureCookies,
    // 256 KB is far above any legitimate body here; the largest is a broadcast message.
    bodyLimit: 256 * 1024,
    // The dashboard polls every few seconds; per-request logging would bury the log lines that
    // matter. Actions are logged explicitly and durably in the audit trail instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, body, unexpected } = toErrorResponse(error);

    if (unexpected) {
      logger.error({ err: error, method: request.method, url: request.url }, 'Unhandled error');
    } else if (status >= 500) {
      logger.warn(
        { method: request.method, url: request.url, status, reason: body.error.message },
        'Request failed',
      );
    }

    void reply.code(status).send(body);
  });

  // `secret` enables signed cookies, which is how sessions are tamper-proof.
  await app.register(cookie, { secret: config.auth.sessionSecret });

  // `global: false` so only routes that opt in are limited — the login route is the only one
  // that needs it.
  await app.register(rateLimit, { global: false });

  // Public first, then protected in its own encapsulation context.
  await app.register(publicApiRoutes(ctx), { prefix: '/api' });
  await app.register(protectedApiRoutes(ctx), { prefix: '/api' });

  const webDist = findWebDist(config.webDistCandidates);

  if (webDist === null) {
    logger.warn(
      { candidates: config.webDistCandidates },
      'No built frontend found; serving API only. Run `npm run dev` for the Vite dev server, or `npm run build` to produce the SPA.',
    );
  } else {
    logger.debug({ webDist }, 'Serving built frontend');
    await app.register(fastifyStatic, {
      root: webDist,
      // Do not register a catch-all wildcard; the notFoundHandler below owns SPA fallback.
      wildcard: false,
      index: false,
    });
  }

  /**
   * Fallback handler.
   *
   * `/api` misses return JSON so a mistyped endpoint never yields an HTML page to a fetch
   * caller. Everything else that is a GET is a client-side route (Vue Router uses history mode),
   * so it receives `index.html` and the SPA resolves it. This is what makes deep links such as
   * `/bans` work on a hard refresh.
   */
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api');
    const isReadable = request.method === 'GET' || request.method === 'HEAD';

    if (isApi || !isReadable || webDist === null) {
      void reply
        .code(404)
        .send(errorBody('not_found', `No route for ${request.method} ${request.url}`));
      return;
    }

    // `sendFile` is provided by @fastify/static.
    void reply.sendFile('index.html');
  });

  return app;
}
