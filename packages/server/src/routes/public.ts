import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@palsentry/shared';
import type { AppContext } from '../context.js';
import { SESSION_COOKIE_NAME, createSessionValue, sessionCookieOptions } from '../auth/session.js';
import { verifyCredentials } from '../auth/password.js';
import { HttpError, errorBody, parseOrThrow } from '../http/errors.js';
import { loginSchema } from '../http/schemas.js';
import { APP_VERSION } from '../version.js';
import { readSession } from '../plugins/session.js';
import type { HealthResponse } from '@palsentry/shared';

/**
 * Routes that must work without a session.
 *
 * Registered in their own Fastify encapsulation context so the auth guard, which lives in the
 * protected plugin, simply does not apply here. Nothing is made public by a URL-string check.
 */
export function publicApiRoutes(ctx: AppContext) {
  const { config, logger } = ctx;
  const cookieOptions = sessionCookieOptions(
    config.auth.secureCookies,
    config.auth.sessionTtlHours,
  );

  return async function publicApi(app: FastifyInstance): Promise<void> {
    /**
     * Liveness probe. Kept unauthenticated so Docker's HEALTHCHECK works before anyone signs in.
     * Deliberately reveals nothing about the Palworld server.
     */
    app.get('/health', async (): Promise<HealthResponse> => {
      return {
        status: 'ok',
        version: APP_VERSION,
        uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      };
    });

    app.post(
      '/auth/login',
      {
        config: {
          // Scoped to this route only. Ten attempts per IP per 15 minutes makes online password
          // guessing impractical without locking out a legitimate admin who fat-fingers once.
          rateLimit: { max: 10, timeWindow: '15 minutes' },
        },
      },
      async (request, reply): Promise<MeResponse> => {
        const body = parseOrThrow(loginSchema, request.body);

        const valid = verifyCredentials(
          { username: config.auth.username, passwordHash: config.auth.passwordHash },
          body.username,
          body.password,
        );

        if (!valid) {
          logger.warn({ ip: request.ip, username: body.username }, 'Failed sign-in attempt');
          // Deliberately identical for a bad username and a bad password.
          throw HttpError.unauthorized('Incorrect username or password.');
        }

        reply.setCookie(
          SESSION_COOKIE_NAME,
          createSessionValue(config.auth.username, config.auth.sessionTtlHours),
          cookieOptions,
        );

        logger.info({ ip: request.ip, username: config.auth.username }, 'Signed in');
        return { authenticated: true, user: { username: config.auth.username } };
      },
    );

    app.post('/auth/logout', async (request, reply): Promise<MeResponse> => {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      logger.info({ ip: request.ip }, 'Signed out');
      return { authenticated: false, user: null };
    });

    /** Used by the SPA on boot to decide between the login screen and the dashboard. */
    app.get('/auth/me', async (request, reply): Promise<MeResponse> => {
      const session = readSession(request, config);
      if (session === null) {
        return { authenticated: false, user: null };
      }
      // Keeps an active session alive: a session's expiry is baked into the cookie, so without
      // reissuing it an admin working through a long session would be logged out mid-task.
      reply.setCookie(
        SESSION_COOKIE_NAME,
        createSessionValue(config.auth.username, config.auth.sessionTtlHours),
        cookieOptions,
      );
      return { authenticated: true, user: session };
    });

    /** Explicit JSON 404 for unknown public routes, so /api never returns an HTML page. */
    app.setNotFoundHandler((request, reply) => {
      void reply
        .code(404)
        .send(errorBody('not_found', `No API route for ${request.method} ${request.url}`));
    });
  };
}
