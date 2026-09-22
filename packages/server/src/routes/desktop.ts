import type { ConnectionRequest, ConnectionStatusResponse } from '@palsentry/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError, parseOrThrow } from '../http/errors.js';
import { connectionSchema } from '../http/schemas.js';

/**
 * Desktop-only connection routes.
 *
 * These are registered in the **public** plugin on purpose. In desktop mode `/auth/me` reports
 * "not signed in" until a Palworld connection exists, so a protected route could never be reached
 * from the connection screen — which is exactly when the user needs it.
 *
 * Safety comes from three things instead of a session:
 *
 * 1. The routes only exist when `PALSENTRY_DESKTOP=1`.
 * 2. The server binds loopback, and the desktop shell chooses the port.
 * 3. `desktopConnectionGuard` requires a JSON content type, so a cross-origin `<form>` (which can
 *    only send urlencoded, multipart or plain text) cannot reach a mutating handler.
 */
export function desktopConnectionRoutes(ctx: AppContext) {
  return async function desktopConnection(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', desktopConnectionGuard);

    /** Current connection state, for prefilling the form. Never returns the password. */
    app.get('/connection', async (): Promise<ConnectionStatusResponse> => {
      return ctx.desktopSettings.status();
    });

    /**
     * Validate, probe, apply and remember a connection.
     *
     * Failing here is the normal path for a typo: the response carries the upstream message so the
     * form can show "the Palworld server rejected the API credentials" instead of a silent
     * offline dashboard.
     */
    app.post('/connection', async (request): Promise<ConnectionStatusResponse> => {
      const body = parseOrThrow(connectionSchema, request.body) as ConnectionRequest;

      return ctx.desktopSettings.connect(
        {
          restUrl: body.restUrl,
          adminPassword: body.adminPassword,
          username: body.username,
        },
        request.ip,
      );
    });

    /** Forget the password and stop sampling. The remembered REST URL survives. */
    app.post('/connection/disconnect', async (request): Promise<ConnectionStatusResponse> => {
      return ctx.desktopSettings.disconnect(request.ip);
    });
  };
}

/**
 * Require JSON for the mutating desktop routes.
 *
 * Mirrors the check the session guard applies to protected routes, for the same CSRF reason — but
 * it has to live here too because these routes are deliberately outside that guard.
 *
 * Must stay `async`: Fastify only advances a hook that returns a promise or calls its `next`
 * callback, so a plain synchronous function here would leave every request hanging.
 */
async function desktopConnectionGuard(request: FastifyRequest): Promise<void> {
  if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') return;

  const contentType = String(request.headers['content-type'] ?? '');
  if (contentType.toLowerCase().includes('application/json')) return;

  throw new HttpError(
    415,
    'validation',
    'Expected Content-Type: application/json. This endpoint does not accept form submissions.',
  );
}
