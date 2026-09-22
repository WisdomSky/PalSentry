import type { ActionName, ActionResponse } from '@palsentry/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOrThrow, toErrorResponse } from '../http/errors.js';
import { assertActionAllowed } from '../http/gate.js';
import {
  announceSchema,
  banSchema,
  kickSchema,
  shutdownSchema,
  unbanSchema,
} from '../http/schemas.js';
import type { RequestMeta } from '../palworld/client.js';

/**
 * Actions against the Palworld server.
 *
 * Every route funnels through {@link perform} so three things cannot be forgotten on a new
 * endpoint:
 *  1. the `PALSENTRY_ALLOW_DESTRUCTIVE` gate,
 *  2. an audit record — including for blocked and failed attempts,
 *  3. a consistent response shape.
 */

/** Operator-facing confirmation text per action. */
const SUCCESS_MESSAGE: Record<ActionName, string> = {
  announce: 'Message broadcast to the server.',
  save: 'World saved.',
  kick: 'Player kicked.',
  ban: 'Player banned.',
  unban: 'Player unbanned.',
  shutdown: 'Shutdown scheduled.',
  stop: 'Server force-stopped.',
  restart: 'Restart started.',
};

/**
 * Enforce the destructive-action gate.
 *
 * Blocked attempts are audited rather than silently dropped: if the UI is misconfigured or
 * someone is poking at the API, that should be visible in the trail.
 */
interface PerformOptions {
  action: ActionName;
  target: string | null;
  payload: unknown;
  run: () => Promise<RequestMeta>;
}

/** Run an action, audit the outcome, and return the standard response. */
async function perform(
  ctx: AppContext,
  request: FastifyRequest,
  options: PerformOptions,
): Promise<ActionResponse> {
  const { action, target, payload } = options;
  const actorName = request.session?.username ?? null;
  const actorIp = request.ip;
  const startedAt = performance.now();

  try {
    const meta = await options.run();
    const durationMs = Math.round(performance.now() - startedAt);

    ctx.audit.record({
      actorName,
      actorIp,
      action,
      target,
      payload,
      httpStatus: meta.status,
      ok: true,
      error: null,
      durationMs,
    });
    ctx.logger.info(
      { action, target, durationMs, actor: actorName, ip: actorIp },
      `${action} succeeded`,
    );

    return { ok: true, action, target, message: SUCCESS_MESSAGE[action], durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const { status, body } = toErrorResponse(error);

    ctx.audit.record({
      actorName,
      actorIp,
      action,
      target,
      payload,
      httpStatus: status,
      ok: false,
      error: body.error.message,
      durationMs,
    });
    ctx.logger.warn(
      { action, target, status, reason: body.error.message, actor: actorName, ip: actorIp },
      `${action} failed`,
    );

    // Rethrow so the central error handler renders the response consistently.
    throw error;
  }
}

export function actionRoutes(ctx: AppContext) {
  return async function actions(app: FastifyInstance): Promise<void> {
    /** Broadcast a message to every player. Never destructive, so always available. */
    app.post('/actions/announce', async (request): Promise<ActionResponse> => {
      const body = parseOrThrow(announceSchema, request.body);
      assertActionAllowed(ctx, request, 'announce');
      return perform(ctx, request, {
        action: 'announce',
        target: null,
        payload: body,
        run: () => ctx.client.announce(body.message),
      });
    });

    /** Flush the world to disk. Never destructive, so always available. */
    app.post('/actions/save', async (request): Promise<ActionResponse> => {
      assertActionAllowed(ctx, request, 'save');
      return perform(ctx, request, {
        action: 'save',
        target: null,
        payload: {},
        run: () => ctx.client.save(),
      });
    });

    app.post('/actions/kick', async (request): Promise<ActionResponse> => {
      const body = parseOrThrow(kickSchema, request.body);
      assertActionAllowed(ctx, request, 'kick');
      return perform(ctx, request, {
        action: 'kick',
        target: body.userid,
        payload: body,
        run: () => ctx.client.kick(body.userid, body.message),
      });
    });

    app.post('/actions/ban', async (request): Promise<ActionResponse> => {
      const body = parseOrThrow(banSchema, request.body);
      assertActionAllowed(ctx, request, 'ban');

      return perform(ctx, request, {
        action: 'ban',
        target: body.userid,
        payload: body,
        run: async () => {
          const meta = await ctx.client.ban(body.userid, body.message);

          // Record the ban only after the upstream call succeeds, so the registry never claims
          // a ban the game server did not accept.
          ctx.bans.recordBan({
            userid: body.userid,
            playerName: body.playerName ?? null,
            reason: body.reason ?? body.message ?? null,
            actorName: request.session?.username ?? null,
            actorIp: request.ip,
            rawResponse: meta.body,
          });

          return meta;
        },
      });
    });

    app.post('/actions/unban', async (request): Promise<ActionResponse> => {
      const body = parseOrThrow(unbanSchema, request.body);
      assertActionAllowed(ctx, request, 'unban');

      return perform(ctx, request, {
        action: 'unban',
        target: body.userid,
        payload: body,
        run: async () => {
          const meta = await ctx.client.unban(body.userid);
          // No match is fine: the ban may have been issued outside PalSentry. The upstream
          // unban is what actually lifts the ban.
          ctx.bans.markUnbanned(body.userid, request.ip);
          return meta;
        },
      });
    });

    /** Graceful shutdown after `waittime` seconds. */
    app.post('/actions/shutdown', async (request): Promise<ActionResponse> => {
      const body = parseOrThrow(shutdownSchema, request.body);
      assertActionAllowed(ctx, request, 'shutdown');
      return perform(ctx, request, {
        action: 'shutdown',
        target: null,
        payload: body,
        run: () => ctx.client.shutdown(body.waittime, body.message),
      });
    });

    /** Immediate, ungraceful stop. No save, no warning. */
    app.post('/actions/stop', async (request): Promise<ActionResponse> => {
      assertActionAllowed(ctx, request, 'stop');
      return perform(ctx, request, {
        action: 'stop',
        target: null,
        payload: {},
        run: () => ctx.client.stop(),
      });
    });
  };
}
