import type {
  BanRecord,
  BasesResponse,
  EnrichedPlayer,
  MetaResponse,
  PalworldPlayer,
  PlayersResponse,
  SettingsResponse,
  StatusResponse,
} from '@palsentry/shared';
import {
  DEFAULT_POLL_INTERVAL_MS,
  POLL_INTERVAL_OPTIONS,
  WAYBACK_INTERVAL_OPTIONS,
} from '@palsentry/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { toStatusError } from '../http/errors.js';
import type { StoredPlayer } from '../services/players.js';
import { isPalworldError } from '../palworld/errors.js';
import { APP_VERSION } from '../version.js';

/**
 * Runtime capabilities the SPA needs before it can render correctly.
 *
 * Fetching this once at startup (rather than discovering capabilities from failures) is what
 * lets the UI disable destructive buttons honestly instead of showing a button that 403s.
 */
export function metaRoutes(ctx: AppContext) {
  return async function meta(app: FastifyInstance): Promise<void> {
    app.get('/meta', async (): Promise<MetaResponse> => {
      return {
        app: {
          version: APP_VERSION,
          // Desktop hosting replaces the PalSentry login with the Palworld connection screen.
          authEnabled: !ctx.config.desktop.enabled,
          desktop: ctx.config.desktop.enabled,
        },
        destructiveAllowed: ctx.config.allowDestructive,
        map: ctx.config.map,
        polling: {
          defaultIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          options: [...POLL_INTERVAL_OPTIONS],
        },
        history: {
          retentionDays: ctx.config.history.retentionDays,
          sampleIntervalSeconds: ctx.config.history.sampleIntervalSeconds,
          // Position recording is a server-wide setting rather than deployment configuration, so
          // this reports the interval actually in force, not a default the UI would have to guess.
          waybackIntervalSeconds: ctx.playerHistory.intervalSeconds,
          waybackIntervalOptions: [...WAYBACK_INTERVAL_OPTIONS],
        },
        restart: {
          defaultWaitSeconds: ctx.config.restart.defaultWaitSeconds,
        },
      };
    });
  };
}

/**
 * Server status.
 *
 * Returns `200` with `online: false` when the game server is unreachable rather than a 502.
 * The dashboard's whole job includes showing "your server is off", so that state has to be a
 * successful response the SPA can render — not an error it has to special-case.
 */
export function statusRoutes(ctx: AppContext) {
  return async function status(app: FastifyInstance): Promise<void> {
    app.get('/status', async (): Promise<StatusResponse> => {
      const checkedAt = new Date().toISOString();
      const startedAt = performance.now();

      try {
        // Independent endpoints, so one round trip instead of two sequential ones.
        const [info, metrics] = await Promise.all([ctx.client.info(), ctx.client.metrics()]);
        return {
          online: true,
          checkedAt,
          latencyMs: Math.round(performance.now() - startedAt),
          info,
          metrics,
          error: null,
        };
      } catch (error) {
        return {
          online: false,
          checkedAt,
          latencyMs: null,
          info: null,
          metrics: null,
          error: toStatusError(error),
        };
      }
    });
  };
}

/**
 * Fold one roster entry, its live session (when it has one), and its ban state into a response row.
 *
 * The stored row supplies the identity fields so online and offline rows cannot disagree about a
 * player's name or level, and the live row supplies only what describes the current session.
 */
function enrich(
  stored: StoredPlayer,
  live: PalworldPlayer | undefined,
  ban: BanRecord | undefined,
): EnrichedPlayer {
  const identity = {
    name: stored.name,
    accountName: stored.accountName,
    playerId: stored.playerId,
    userId: stored.userId,
    location_x: stored.location_x,
    location_y: stored.location_y,
    level: stored.level,
    banned: ban !== undefined,
    banReason: ban?.reason ?? null,
    bannedAt: ban?.bannedAt ?? null,
    lastOnline: stored.lastOnlineAt,
  };

  if (live === undefined) {
    return { ...identity, online: false, ip: null, ping: null, building_count: null };
  }

  return {
    ...identity,
    online: true,
    ip: live.ip,
    ping: live.ping,
    building_count: live.building_count,
  };
}

/**
 * The retained roster, with each entry flagged as online or not.
 *
 * Every request refreshes the roster from the game server, so this doubles as the live view. When
 * the game server cannot be reached the roster is still returned — with everyone reported offline
 * — because forgetting every player the moment the server restarts would be the opposite of what
 * a roster is for. Callers distinguish the two by the response-level `online` flag.
 */
export function playersRoutes(ctx: AppContext) {
  return async function players(app: FastifyInstance): Promise<void> {
    app.get('/players', async (): Promise<PlayersResponse> => {
      const snapshot = await ctx.players.refresh();
      // Only a successful read may be read as "these players are connected"; a failed one says
      // nothing about who is online, so nobody gets to be flagged as online.
      const live = new Map(
        snapshot.ok ? snapshot.players.map((player) => [player.userId, player]) : [],
      );
      const banMap = ctx.bans.activeBanMap();

      return {
        online: snapshot.ok,
        checkedAt: snapshot.observedAt,
        players: ctx.players
          .list()
          .map((stored) => enrich(stored, live.get(stored.userId), banMap.get(stored.userId))),
        error: snapshot.ok ? null : toStatusError(snapshot.error),
      };
    });
  };
}

/** Optional guild-base layer sourced from Palworld's opt-in game-data endpoint. */
export function basesRoutes(ctx: AppContext) {
  return async function bases(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { refresh?: string } }>(
      '/bases',
      async (request): Promise<BasesResponse> => {
        const checkedAt = new Date().toISOString();

        try {
          return {
            available: true,
            checkedAt,
            bases: await ctx.client.guildBases({ force: request.query.refresh === 'true' }),
            error: null,
          };
        } catch (error) {
          const mapped = toStatusError(error);
          const needsGameData =
            isPalworldError(error) &&
            ['bad_request', 'not_found', 'invalid_response'].includes(error.kind);

          return {
            available: false,
            checkedAt,
            bases: [],
            error: {
              ...mapped,
              message: needsGameData
                ? 'Guild bases require the Palworld game-data API. Restart the game server with -enable-gamedata-api, then retry.'
                : mapped.message,
            },
          };
        }
      },
    );
  };
}

/**
 * Read-only settings dump.
 *
 * Unlike `/status` and `/players` this propagates failures: an empty settings page with no
 * explanation would be more confusing than an error message.
 */
export function settingsRoutes(ctx: AppContext) {
  return async function settings(app: FastifyInstance): Promise<void> {
    app.get('/settings', async (): Promise<SettingsResponse> => {
      return { settings: await ctx.client.settings() };
    });
  };
}
