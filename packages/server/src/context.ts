import type { AppConfig } from './config.js';
import { openDatabase, type Db } from './db/index.js';
import type { Logger } from './logger.js';
import { PalworldClient } from './palworld/client.js';
import { AuditService } from './services/audit.js';
import { BanService } from './services/bans.js';
import { DesktopSettingsService } from './services/desktop-settings.js';
import { MetricsPoller } from './services/metrics-poller.js';
import { PlayerHistoryService } from './services/player-history.js';
import { PlayerService } from './services/players.js';
import { RestartService } from './services/restart.js';

/**
 * Long-lived dependencies shared by every route.
 *
 * Built once at startup and passed into route factories rather than attached to the Fastify
 * instance, so tests can assemble a context around a stubbed Palworld server without touching
 * decorators or global state.
 */
export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  client: PalworldClient;
  bans: BanService;
  audit: AuditService;
  metrics: MetricsPoller;
  players: PlayerService;
  /** Records where players have been, and owns the background recording timer. */
  playerHistory: PlayerHistoryService;
  restart: RestartService;
  /**
   * The desktop app's Palworld connection.
   *
   * Always present so routes can ask it anything, but `enabled` is false outside desktop mode and
   * nothing but the desktop routes ever reads it.
   */
  desktopSettings: DesktopSettingsService;
  /** Unix ms at process start, for the health endpoint's uptime. */
  startedAt: number;
}

export function createContext(config: AppConfig, logger: Logger): AppContext {
  const db = openDatabase(config.dbPath, logger);
  const client = new PalworldClient(config.palworld, logger);
  const audit = new AuditService(db);
  const bans = new BanService(db);
  const players = new PlayerService({ db, client, logger });

  const metrics = new MetricsPoller({
    db,
    client,
    logger,
    intervalSeconds: config.history.sampleIntervalSeconds,
    retentionDays: config.history.retentionDays,
  });

  // Records at its own persisted cadence rather than the metric sampling interval: position
  // detail is what makes a replay useful, and it is the operator who knows how much detail the
  // current investigation needs.
  const playerHistory = new PlayerHistoryService({
    db,
    players,
    logger,
    retentionDays: config.history.retentionDays,
  });

  return {
    config,
    logger,
    db,
    client,
    bans,
    audit,
    metrics,
    players,
    playerHistory,
    restart: new RestartService({ client, audit, logger, config: config.restart }),
    desktopSettings: new DesktopSettingsService({
      config,
      client,
      metrics,
      playerHistory,
      audit,
      logger,
    }),
    startedAt: Date.now(),
  };
}

/** Release resources held by the context. Safe to call more than once. */
export async function closeContext(ctx: AppContext): Promise<void> {
  // Stop background work before closing the database it writes to, and wait for any in-flight
  // write so shutdown cannot race a sample insert.
  ctx.restart.stop();
  await Promise.all([ctx.metrics.stop(), ctx.playerHistory.stop(), ctx.players.stop()]);

  try {
    ctx.db.close();
  } catch {
    // Already closed, or never opened — nothing useful to do during shutdown.
  }
}
