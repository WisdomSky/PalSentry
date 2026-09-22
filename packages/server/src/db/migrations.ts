import type { Db } from './index.js';
import type { Logger } from '../logger.js';

/**
 * Schema migrations, tracked with SQLite's built-in `PRAGMA user_version`.
 *
 * Migrations are append-only: never edit a released entry, add a new one. Each runs inside a
 * transaction together with its version bump, so a failure leaves the database on the previous
 * version rather than half-migrated.
 *
 * A note on `bans`: each row is a *ban episode*, not a player. Banning, unbanning, and banning
 * again produces two rows so the history is preserved. The partial unique index below enforces
 * at most one active episode per `userid` at the database level.
 */

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema: bans, audit, metric_samples',
    up: (db) => {
      db.exec(`
        -- Ban registry. The Palworld REST API can ban and unban but cannot list bans, so this
        -- table is the dashboard's source of truth for bans issued through PalSentry.
        CREATE TABLE bans (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          userid            TEXT    NOT NULL,
          player_name       TEXT,
          reason            TEXT,
          actor_name        TEXT,
          actor_ip          TEXT,
          banned_at         TEXT    NOT NULL,
          active            INTEGER NOT NULL DEFAULT 1,
          unbanned_at       TEXT,
          unbanned_by_ip    TEXT,
          raw_response      TEXT
        );

        CREATE INDEX idx_bans_userid ON bans(userid);
        CREATE INDEX idx_bans_banned_at ON bans(banned_at DESC);

        -- At most one active ban per player, enforced by the database rather than by
        -- application logic that could drift.
        CREATE UNIQUE INDEX idx_bans_one_active_per_user
          ON bans(userid) WHERE active = 1;

        -- Append-only audit trail. Retained indefinitely: rows are small and the history is
        -- the point. There is no actor user id because PalSentry is single-operator; the
        -- session username and source IP are recorded instead.
        CREATE TABLE audit (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ts            TEXT    NOT NULL,
          actor_name    TEXT,
          actor_ip      TEXT,
          action        TEXT    NOT NULL,
          target        TEXT,
          payload_json  TEXT,
          http_status   INTEGER,
          ok            INTEGER NOT NULL,
          error         TEXT,
          duration_ms   INTEGER
        );

        CREATE INDEX idx_audit_ts ON audit(ts DESC);
        CREATE INDEX idx_audit_action ON audit(action, ts DESC);

        -- Time series backing the performance charts. Written by the background metrics
        -- poller, pruned by PALSENTRY_HISTORY_RETENTION_DAYS.
        CREATE TABLE metric_samples (
          ts                INTEGER PRIMARY KEY,
          serverfps         INTEGER NOT NULL,
          currentplayernum  INTEGER NOT NULL,
          maxplayernum      INTEGER NOT NULL,
          serverframetime   REAL    NOT NULL,
          uptime            INTEGER NOT NULL,
          basecampnum       INTEGER NOT NULL,
          days              INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'durable player roster',
    up: (db) => {
      db.exec(`
        -- Every player PalSentry has seen. The live /players endpoint only reports who is
        -- connected right now, so without this table the Players tab forgets people the moment
        -- they disconnect and only ever shows whoever happens to be online.
        --
        -- Only fields worth keeping indefinitely are stored. IP address, ping, and building
        -- count describe a live session rather than the account, so they are deliberately not
        -- retained: the roster should not become a permanent connection log. The userid column is
        -- the stable key Palworld's actions target, never the display name.
        CREATE TABLE players (
          userid          TEXT    PRIMARY KEY,
          player_id       TEXT    NOT NULL,
          name            TEXT    NOT NULL,
          account_name    TEXT    NOT NULL,
          level           INTEGER NOT NULL,
          location_x      REAL    NOT NULL,
          location_y      REAL    NOT NULL,
          first_seen_at   TEXT    NOT NULL,
          last_online_at  TEXT    NOT NULL
        );

        -- The Players tab lists by recency; ISO-8601 UTC strings sort chronologically.
        CREATE INDEX idx_players_last_online ON players(last_online_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'wayback player position history',
    up: (db) => {
      db.exec(`
        -- Persisted recording cadence for wayback position sampling. A single row (id = 1) rather
        -- than a key/value table: there is exactly one interval, and the CHECK keeps a buggy
        -- writer from parking an absurd cadence in the database.
        CREATE TABLE wayback_settings (
          id               INTEGER PRIMARY KEY CHECK (id = 1),
          interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
          updated_at       TEXT    NOT NULL
        );

        INSERT INTO wayback_settings (id, interval_seconds, updated_at)
        VALUES (1, 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

        -- One row per successful background observation, including observations where nobody was
        -- online: "the server answered and the world was empty" is a fact worth keeping, and
        -- without it the timeline could not distinguish an outage from an empty server.
        --
        -- Gaps in captured_at are real: failed reads leave no row, so the trail breaks there
        -- rather than drawing a straight line across an outage.
        CREATE TABLE player_position_snapshots (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at  INTEGER NOT NULL UNIQUE,
          player_count INTEGER NOT NULL,
          -- 1 for rows synthesised once from the pre-upgrade roster, which recorded only each
          -- player's latest sighting. They are usable as history but are not timeline ticks.
          synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1))
        );

        -- The unique index on captured_at doubles as the range-scan index for both history
        -- queries and retention pruning, so no separate index is needed.

        -- Positions observed in one snapshot. captured_at is denormalised from the parent so the
        -- per-player lookups ("where was this player last, before time T?") never need a join;
        -- the price is 8 bytes per row on the largest table in the schema.
        --
        -- Storage scales with the configured cadence: the 60-second default is roughly 12k rows
        -- per day, while the 5-second option is roughly 138k per day, per player online.
        CREATE TABLE player_positions (
          snapshot_id INTEGER NOT NULL REFERENCES player_position_snapshots(id) ON DELETE CASCADE,
          captured_at INTEGER NOT NULL,
          userid      TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          level       INTEGER NOT NULL,
          location_x  REAL    NOT NULL,
          location_y  REAL    NOT NULL,
          PRIMARY KEY (snapshot_id, userid)
        );

        -- Serves both the in-range scan and the "latest point at or before T" baseline lookup.
        CREATE INDEX idx_player_positions_player_time ON player_positions(userid, captured_at);

        -- Recover what the roster already knows. Older positions cannot be reconstructed, but
        -- each roster row's last_online_at was a genuine successful observation, so it can seed
        -- the map instead of leaving the new feature blank until the first tick.
        INSERT INTO player_position_snapshots (captured_at, player_count, synthetic)
        SELECT CAST(strftime('%s', last_online_at) AS INTEGER), 0, 1
        FROM players
        WHERE strftime('%s', last_online_at) IS NOT NULL
        GROUP BY CAST(strftime('%s', last_online_at) AS INTEGER);

        INSERT INTO player_positions (snapshot_id, captured_at, userid, name, level, location_x, location_y)
        SELECT s.id,
               s.captured_at,
               p.userid,
               p.name,
               p.level,
               p.location_x,
               p.location_y
        FROM players p
        JOIN player_position_snapshots s
          ON s.captured_at = CAST(strftime('%s', p.last_online_at) AS INTEGER)
        WHERE s.synthetic = 1;

        UPDATE player_position_snapshots
        SET player_count = (
          SELECT COUNT(*) FROM player_positions WHERE snapshot_id = player_position_snapshots.id
        )
        WHERE synthetic = 1;
      `);
    },
  },
];

/** The newest schema version this build knows how to produce. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function getSchemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Apply any migrations this build has that the database does not.
 *
 * Databases newer than the running build are refused rather than opened: that happens when
 * someone downgrades the image, and writing to a schema we do not understand risks data loss.
 */
export function runMigrations(db: Db, logger: Logger): void {
  const current = getSchemaVersion(db);

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}). ` +
        'This usually means the container was downgraded. Use a newer PalSentry image, or restore ' +
        'a backup taken with the older version.',
    );
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > current).sort(
    (a, b) => a.version - b.version,
  );

  if (pending.length === 0) {
    logger.debug({ schemaVersion: current }, 'Database schema is up to date');
    return;
  }

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      // Interpolated because PRAGMA does not accept bound parameters. `version` comes from the
      // constant list above, never from user input.
      db.pragma(`user_version = ${migration.version}`);
    });

    apply();
    logger.info({ version: migration.version, name: migration.name }, 'Applied database migration');
  }
}

/**
 * Delete metric samples older than the retention window.
 *
 * Called on startup and then on a timer. Returns the number of rows removed.
 */
export function pruneMetricSamples(db: Db, retentionDays: number, now = Date.now()): number {
  const cutoffSeconds = Math.floor(now / 1000) - retentionDays * 24 * 60 * 60;
  const result = db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(cutoffSeconds);
  return result.changes;
}

/**
 * Delete wayback position history older than the retention window.
 *
 * There is no metric equivalent to delete: bans and audit rows are kept forever. Returns the
 * number of observations removed.
 *
 * Positions are deleted first. The foreign key would cascade them when the parent goes, but the
 * explicit order means the cleanup still holds if the connection was opened without foreign key
 * enforcement, and it keeps the boundary exact for both tables.
 */
export function prunePlayerHistory(db: Db, retentionDays: number, now = Date.now()): number {
  const cutoffSeconds = Math.floor(now / 1000) - retentionDays * 24 * 60 * 60;

  const prune = db.transaction(() => {
    db.prepare('DELETE FROM player_positions WHERE captured_at < ?').run(cutoffSeconds);
    return db
      .prepare('DELETE FROM player_position_snapshots WHERE captured_at < ?')
      .run(cutoffSeconds).changes;
  });

  return prune();
}
