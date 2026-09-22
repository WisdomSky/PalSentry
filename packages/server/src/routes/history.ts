import type { HistoryResponse } from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow } from '../http/errors.js';
import { historyQuerySchema } from '../http/schemas.js';

/** Downsampled metrics history for the Metrics charts. */
export function historyRoutes(ctx: AppContext) {
  const querySchema = historyQuerySchema(ctx.config.history.retentionDays);

  return async function history(app: FastifyInstance): Promise<void> {
    app.get('/history', async (request): Promise<HistoryResponse> => {
      const selection = parseOrThrow(querySchema, request.query);
      return ctx.metrics.history(selection);
    });
  };
}
