import type { BansResponse } from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError, parseOrThrow } from '../http/errors.js';
import { idParamSchema } from '../http/schemas.js';

/**
 * Ban registry routes.
 *
 * Read and bookkeeping only. Actually lifting a ban goes through
 * `POST /api/actions/unban`, because that is the call that reaches the game server — deleting a
 * row here deliberately does *not* unban anyone, and the UI says so.
 */
export function bansRoutes(ctx: AppContext) {
  return async function bans(app: FastifyInstance): Promise<void> {
    app.get('/bans', async (): Promise<BansResponse> => {
      return { bans: ctx.bans.list() };
    });

    /**
     * Forget a registry row.
     *
     * Only touches Palsentry's own bookkeeping. Audited so a removed entry is still traceable —
     * otherwise deleting a row would be a way to hide a ban you issued.
     */
    app.delete('/bans/:id', async (request, reply): Promise<void> => {
      const { id } = parseOrThrow(idParamSchema, request.params);

      const deleted = ctx.bans.deleteById(id);

      if (!deleted) {
        throw HttpError.notFound(`No ban registry entry with id ${id}.`);
      }

      ctx.audit.record({
        actorName: request.session?.username ?? null,
        actorIp: request.ip,
        action: 'bans.delete',
        target: String(id),
        payload: null,
        httpStatus: 204,
        ok: true,
        error: null,
        durationMs: null,
      });

      await reply.code(204).send();
    });
  };
}
