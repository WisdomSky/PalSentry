import { DEFAULT_WAYBACK_WINDOW, type PlayerHistoryResponse } from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow } from '../http/errors.js';
import { historyQuerySchema } from '../http/schemas.js';

/**
 * Wayback player movement.
 *
 * Reads are the same shape as the metrics history endpoint — one retention-bounded range in, a
 * downsampled series out — because the map scrubs a range the same way a chart does. The recording
 * cadence itself is deployment configuration (`PALSENTRY_WAYBACK_INTERVAL_SECONDS`), so there is
 * nothing here to write.
 */
export function playerHistoryRoutes(ctx: AppContext) {
  // A day rather than the metrics default: "where was everyone last night?" is the question this
  // view exists to answer, and six hours is not always enough to cover a session.
  const querySchema = historyQuerySchema(ctx.config.history.retentionDays, DEFAULT_WAYBACK_WINDOW);

  return async function playerHistory(app: FastifyInstance): Promise<void> {
    app.get('/player-history', async (request): Promise<PlayerHistoryResponse> => {
      const selection = parseOrThrow(querySchema, request.query);
      return ctx.playerHistory.history(selection);
    });
  };
}
