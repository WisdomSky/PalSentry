import type { RestartStatusResponse } from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow } from '../http/errors.js';
import { assertActionAllowed } from '../http/gate.js';
import { restartSchema } from '../http/schemas.js';

/**
 * Restart route.
 *
 * `POST /api/restart` returns immediately with the initial status; the sequence takes tens of
 * seconds and the UI follows it via `GET /api/restart/status`. The audit entry for the restart
 * itself is written by {@link RestartService} once the outcome is known, so the trail records
 * whether the server actually came back rather than just that a button was pressed.
 */
export function restartRoutes(ctx: AppContext) {
  return async function restart(app: FastifyInstance): Promise<void> {
    app.post('/restart', async (request, reply): Promise<RestartStatusResponse> => {
      const body = parseOrThrow(restartSchema, request.body);
      assertActionAllowed(ctx, request, 'restart');

      const status = ctx.restart.start({
        ...(body.waittime === undefined ? {} : { waittime: body.waittime }),
        ...(body.message === undefined ? {} : { message: body.message }),
        actorName: request.session?.username ?? null,
        actorIp: request.ip,
      });

      ctx.logger.info(
        { waittime: status.waittimeSeconds, actor: request.session?.username, ip: request.ip },
        'Server restart requested',
      );

      // 202: the restart has been accepted but is still running.
      //
      // Note: `reply.code()` is called *without* awaiting. Fastify's reply object is a thenable
      // that resolves when the response is sent, so `await reply.code(...)` would deadlock —
      // the response only gets sent by returning from this handler.
      reply.code(202);
      return status;
    });

    app.get('/restart/status', async (): Promise<RestartStatusResponse> => {
      return ctx.restart.getStatus();
    });
  };
}
