import type { AppConfig } from './config.js';
import { openDatabase, type Db } from './db/index.js';
import type { Logger } from './logger.js';
import { PalworldClient } from './palworld/client.js';
import { AuditService } from './services/audit.js';
import { BanService } from './services/bans.js';
import { MetricsPoller } from './services/metrics-poller.js';
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
  restart: RestartService;
  /** Unix ms at process start, for the health endpoint's uptime. */
  startedAt: number;
}

export function createContext(config: AppConfig, logger: Logger): AppContext {
  const db = openDatabase(config.dbPath, logger);
  const client = new PalworldClient(config.palworld, logger);
  const audit = new AuditService(db);
  const bans = new BanService(db);

  return {
    config,
    logger,
    db,
    client,
    bans,
    audit,
    metrics: new MetricsPoller({
      db,
      client,
      logger,
      intervalSeconds: config.history.sampleIntervalSeconds,
      retentionDays: config.history.retentionDays,
    }),
    // The same cadence as metric sampling: one more request per interval is a light load, and
    // this is what notices players who connect and leave between two page views.
    players: new PlayerService({
      db,
      client,
      logger,
      intervalSeconds: config.history.sampleIntervalSeconds,
    }),
    restart: new RestartService({ client, audit, logger, config: config.restart }),
    startedAt: Date.now(),
  };
}

/** Release resources held by the context. Safe to call more than once. */
export async function closeContext(ctx: AppContext): Promise<void> {
  // Stop background work before closing the database it writes to, and wait for any in-flight
  // write so shutdown cannot race a sample insert.
  ctx.restart.stop();
  await Promise.all([ctx.metrics.stop(), ctx.players.stop()]);

  try {
    ctx.db.close();
  } catch {
    // Already closed, or never opened — nothing useful to do during shutdown.
  }
}
