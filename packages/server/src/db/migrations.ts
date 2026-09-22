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
        -- table is the dashboard's source of truth for bans issued through Palsentry.
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
        -- the point. There is no actor user id because Palsentry is single-operator; the
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
        -- Every player Palsentry has seen. The live /players endpoint only reports who is
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
        'This usually means the container was downgraded. Use a newer Palsentry image, or restore ' +
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
