import {
  DEFAULT_WAYBACK_WINDOW,
  WAYBACK_INTERVAL_OPTIONS,
  type PlayerHistoryResponse,
  type WaybackSettingsResponse,
} from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow } from '../http/errors.js';
import { historyQuerySchema, waybackSettingsSchema } from '../http/schemas.js';

/**
 * Wayback player movement: reading recorded history, and choosing how finely it is recorded.
 *
 * Reads are the same shape as the metrics history endpoint — one retention-bounded range in, a
 * downsampled series out — because the map scrubs a range the same way a chart does. Writes are
 * limited to the recording cadence, which is the only knob this feature has.
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

    /**
     * Change how often positions are recorded.
     *
     * Validated by the schema and again by the service, which is what actually writes the value:
     * the schema protects this endpoint, while the service protects the setting from any other
     * caller that might appear later.
     */
    app.put('/player-history/settings', async (request): Promise<WaybackSettingsResponse> => {
      const body = parseOrThrow(waybackSettingsSchema, request.body);
      const previousSeconds = ctx.playerHistory.intervalSeconds;
      const intervalSeconds = ctx.playerHistory.setIntervalSeconds(body.intervalSeconds);

      // Saving the value that is already in force is not a change, so it does not earn an audit
      // row. Cadence changes are recorded with both values because the audit trail is the only
      // place that can explain why an hour of history is coarse or fine.
      if (intervalSeconds !== previousSeconds) {
        ctx.audit.record({
          actorName: request.session?.username ?? null,
          actorIp: request.ip,
          action: 'wayback-interval',
          target: null,
          payload: { fromSeconds: previousSeconds, toSeconds: intervalSeconds },
          httpStatus: 200,
          ok: true,
          error: null,
          durationMs: null,
        });
      }

      return { intervalSeconds, intervalOptions: [...WAYBACK_INTERVAL_OPTIONS] };
    });
  };
}
