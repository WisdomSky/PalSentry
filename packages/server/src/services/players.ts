import type { PalworldPlayer } from '@palsentry/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { PalworldError } from '../palworld/errors.js';
import type { PalworldClient } from '../palworld/client.js';

/**
 * The durable player roster.
 *
 * Palworld's `/players` endpoint answers "who is connected right now?" and nothing more —
 * disconnect and the account vanishes from every response. That is enough for a live view and
 * useless for anything historical, so PalSentry keeps its own roster of everyone it has observed
 * and remembers when each of them was last online.
 *
 * Two deliberate consequences:
 * - Nothing is ever deleted. The roster is small (one row per account that has ever joined) and
 *   "who used to play here?" is exactly the question the table exists to answer.
 * - A snapshot is only written after a *successful* upstream read. Game server outages are
 *   ordinary, and treating one as "everybody left" would stamp a wrong last-online time on every
 *   row at once.
 *
 * The roster is also observed in the background rather than only when a browser asks. A player
 * who connects and disconnects between two page views still belongs in the roster, and the only
 * way to notice them is to look.
 */

/** The retained subset of a player snapshot, plus when that account was first and last seen. */
export interface StoredPlayer {
  userId: string;
  playerId: string;
  name: string;
  accountName: string;
  level: number;
  location_x: number;
  location_y: number;
  /** ISO-8601 instant of the first snapshot this account appeared in. */
  firstSeenAt: string;
  /** ISO-8601 instant of the most recent snapshot this account appeared in. */
  lastOnlineAt: string;
}

interface PlayerRow {
  userid: string;
  player_id: string;
  name: string;
  account_name: string;
  level: number;
  location_x: number;
  location_y: number;
  first_seen_at: string;
  last_online_at: string;
}

function toStoredPlayer(row: PlayerRow): StoredPlayer {
  return {
    userId: row.userid,
    playerId: row.player_id,
    name: row.name,
    accountName: row.account_name,
    level: row.level,
    location_x: row.location_x,
    location_y: row.location_y,
    firstSeenAt: row.first_seen_at,
    lastOnlineAt: row.last_online_at,
  };
}

/** The stored roster. All roster SQL lives here, so it is testable without a game server. */
export class PlayerRoster {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Persist a successful live snapshot.
   *
   * The whole snapshot shares one timestamp, so a slow response cannot make two players who were
   * online together look like they left at different times. `first_seen_at` is written once and
   * deliberately excluded from the update clause; everything else follows the latest snapshot,
   * which is what makes a rename or a level-up show up without creating a second row.
   */
  record(players: readonly PalworldPlayer[], observedAt: Date = new Date()): void {
    if (players.length === 0) return;

    const observed = observedAt.toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO players
         (userid, player_id, name, account_name, level, location_x, location_y, first_seen_at, last_online_at)
       VALUES
         (@userid, @player_id, @name, @account_name, @level, @location_x, @location_y, @first_seen_at, @last_online_at)
       ON CONFLICT(userid) DO UPDATE SET
         player_id      = excluded.player_id,
         name           = excluded.name,
         account_name   = excluded.account_name,
         level          = excluded.level,
         location_x     = excluded.location_x,
         location_y     = excluded.location_y,
         last_online_at = excluded.last_online_at`,
    );

    // One transaction for the whole snapshot: a half-written roster after a crash would be a
    // roster that disagrees with itself about when everyone was online.
    const write = this.db.transaction((rows: readonly PalworldPlayer[]) => {
      for (const player of rows) {
        upsert.run({
          userid: player.userId,
          player_id: player.playerId,
          name: player.name,
          account_name: player.accountName,
          level: player.level,
          location_x: player.location_x,
          location_y: player.location_y,
          first_seen_at: observed,
          last_online_at: observed,
        });
      }
    });

    write(players);
  }

  /**
   * The retained roster, most recently online first.
   *
   * Name and id break ties so the order is stable for accounts last seen in the same second,
   * which keeps the table from reshuffling between polls.
   */
  list(): StoredPlayer[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM players
          ORDER BY last_online_at DESC, name COLLATE NOCASE ASC, userid ASC`,
      )
      .all() as PlayerRow[];
    return rows.map(toStoredPlayer);
  }

  /** Look up one retained account, for enriching a single player. */
  find(userId: string): StoredPlayer | null {
    const row = this.db.prepare('SELECT * FROM players WHERE userid = ?').get(userId) as
      PlayerRow | undefined;
    return row === undefined ? null : toStoredPlayer(row);
  }

  /** How many accounts the roster remembers. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number };
    return row.n;
  }
}

export interface PlayerServiceOptions {
  db: Db;
  client: PalworldClient;
  logger: Logger;
}

/**
 * One attempt at reading who is online.
 *
 * `ok` is what separates "nobody is playing" from "we could not ask": only a successful read may
 * be interpreted as players having left, so every caller has to branch on it.
 */
export interface PlayerSnapshot {
  ok: boolean;
  /** ISO instant the read finished. */
  observedAt: string;
  /** Players reported by this read. Always empty when `ok` is false. */
  players: PalworldPlayer[];
  /** The upstream failure, when `ok` is false. */
  error: unknown;
}

/**
 * Keeps the roster current, and is the single reader of the live player list.
 *
 * Owns the two things the table cannot know by itself: what a failed look means, and that a
 * browser request and a recording tick share one in-flight read, so the roster is never written
 * twice from two slightly different snapshots.
 *
 * It deliberately owns no timer. Scheduling belongs to whoever needs the data at an interval:
 * today that is `PlayerHistoryService`, which reschedules when the operator changes the recording
 * cadence and records what each of its observations saw. Adding a timer here as well would mean
 * two readers sampling the same endpoint on two independent schedules.
 */
export class PlayerService {
  private readonly roster: PlayerRoster;
  private readonly client: PalworldClient;
  private readonly logger: Logger;

  private consecutiveFailures = 0;
  /** The read currently in flight, so callers share one upstream request instead of stacking. */
  private inflight: Promise<PlayerSnapshot> | null = null;

  constructor(options: PlayerServiceOptions) {
    this.roster = new PlayerRoster(options.db);
    this.client = options.client;
    this.logger = options.logger;
  }

  /** Persist a successful snapshot. See {@link PlayerRoster.record}. */
  record(players: readonly PalworldPlayer[], observedAt: Date = new Date()): void {
    this.roster.record(players, observedAt);
  }

  /** The retained roster, most recently online first. */
  list(): StoredPlayer[] {
    return this.roster.list();
  }

  /** Look up one retained account. */
  find(userId: string): StoredPlayer | null {
    return this.roster.find(userId);
  }

  /** How many accounts the roster remembers. */
  count(): number {
    return this.roster.count();
  }

  /**
   * Read who is online, persisting the result when the read succeeds.
   *
   * Never rejects: a game server that is down or restarting is an ordinary event here, and the
   * caller is a request handler that has to answer either way.
   */
  refresh(): Promise<PlayerSnapshot> {
    if (this.inflight !== null) return this.inflight;

    const promise = this.read().finally(() => {
      this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  private async read(): Promise<PlayerSnapshot> {
    try {
      const players = await this.client.players();
      // Stamped after the read, so a slow response cannot date the roster earlier than the
      // moment the game server actually reported it.
      const observedAt = new Date().toISOString();
      this.roster.record(players, new Date(observedAt));

      if (this.consecutiveFailures > 0) {
        this.logger.info(
          { afterFailures: this.consecutiveFailures },
          'Player roster observation recovered',
        );
        this.consecutiveFailures = 0;
      }

      return { ok: true, observedAt, players, error: null };
    } catch (error) {
      const observedAt = new Date().toISOString();
      this.consecutiveFailures += 1;
      const detail = error instanceof PalworldError ? error.message : String(error);

      // Warn once so an outage is visible, then drop to debug — a server that is off overnight
      // should not fill the log with a line per minute.
      if (this.consecutiveFailures === 1) {
        this.logger.warn(
          { reason: detail },
          'Player roster observation failed; last-online times will not advance',
        );
      } else {
        this.logger.debug(
          { reason: detail, consecutiveFailures: this.consecutiveFailures },
          'Player roster observation still failing',
        );
      }

      // Deliberately records nothing: an unreachable server is not evidence that anyone left.
      return { ok: false, observedAt, players: [], error };
    }
  }

  /**
   * Release nothing, but wait for any in-flight read so shutdown cannot race a roster write.
   *
   * The wait matters because the recording timer may be mid-observation when the process is asked
   * to stop, and closing SQLite underneath that write would throw from a callback with nothing
   * left to catch it.
   */
  async stop(): Promise<void> {
    try {
      await this.inflight;
    } catch {
      // `read()` does not reject, but never let shutdown hinge on that.
    }
  }
}
