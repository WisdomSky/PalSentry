import type { AuditResponse } from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow } from '../http/errors.js';
import { auditQuerySchema } from '../http/schemas.js';

/** Read access to the append-only audit trail. */
export function auditRoutes(ctx: AppContext) {
  return async function audit(app: FastifyInstance): Promise<void> {
    app.get('/audit', async (request): Promise<AuditResponse> => {
      const query = parseOrThrow(auditQuerySchema, request.query);

      return ctx.audit.list({
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.actor === undefined ? {} : { actor: query.actor }),
        ...(query.target === undefined ? {} : { target: query.target }),
        // Query strings are always strings, so the boolean arrives as 'true'/'false'.
        ...(query.ok === undefined ? {} : { ok: query.ok === 'true' }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    });
  };
}
