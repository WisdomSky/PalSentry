import type { HistoryResponse } from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow } from '../http/errors.js';
import { historyOptionsSchema, historyQuerySchema } from '../http/schemas.js';

/** Downsampled metrics history for the Metrics charts. */
export function historyRoutes(ctx: AppContext) {
  const querySchema = historyQuerySchema(ctx.config.history.retentionDays);

  return async function history(app: FastifyInstance): Promise<void> {
    app.get('/history', async (request): Promise<HistoryResponse> => {
      const selection = parseOrThrow(querySchema, request.query);
      // The chart that names players opts in; the other three charts do not pay for the lookups.
      const { includePlayers } = parseOrThrow(historyOptionsSchema, request.query);
      return ctx.metrics.history(selection, Date.now(), { includePlayers });
    });
  };
}
