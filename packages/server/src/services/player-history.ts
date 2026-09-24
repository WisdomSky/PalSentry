import {
  DEFAULT_WAYBACK_WINDOW,
  type HistorySelection,
  type HistoryWindow,
  type PlayerHistoryResponse,
  type WaybackPlayerHistory,
  type WaybackPoint,
  type WaybackSnapshot,
} from '@palsentry/shared';
import type { PalworldPlayer } from '@palsentry/shared';
import type { Db } from '../db/index.js';
import { prunePlayerHistory } from '../db/migrations.js';
import type { Logger } from '../logger.js';
import { resolveHistoryRange, waybackBucketSeconds } from './history-range.js';
import type { PlayerService, PlayerSnapshot } from './players.js';

/**
 * Records where players have been, so the map can be replayed.
 *
 * The live map is a snapshot of right now, and the roster only remembers each account's latest
 * position. Neither can answer "where was everyone at 14:20?", which is what makes a griefing
 * report or a "did anyone go near that base?" question unanswerable after the fact.
 *
 * Three properties this service is built around:
 *
 * 1. **The cadence is deployment configuration.** It comes from
 *    `PALSENTRY_WAYBACK_INTERVAL_SECONDS` and never changes while the process is up, so the
 *    sampling rate is something an operator sets alongside the rest of their server config.
 * 2. **Only real observations are recorded.** A failed upstream read writes nothing, so the
 *    timeline keeps an honest gap rather than inventing a straight line across an outage.
 * 3. **An empty observation is still an observation.** A tick that reports nobody online is
 *    stored, which is what lets the timeline distinguish "the server was empty" from "PalSentry
 *    could not reach the server".
 *
 * This does not read the game server itself. It drives {@link PlayerService.refresh}, which
 * already deduplicates concurrent reads and owns the durable roster, so a browser request and a
 * recording tick never stack two upstream requests.
 */

/** How often retention pruning runs while the process is up. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Most players one history response will describe.
 *
 * The roster is unbounded by design (accounts are never forgotten), but a map is not: a response
 * with thousands of players and a point per bucket would be megabytes of JSON nobody can read.
 * Roster order is most-recently-online-first, so the cap drops exactly the accounts that have not
 * been seen in the longest time.
 */
const MAX_HISTORY_PLAYERS = 250;

export interface PlayerHistoryServiceOptions {
  db: Db;
  players: PlayerService;
  logger: Logger;
  /** Shared with metric history: positions are pruned on the same schedule. */
  retentionDays: number;
  /** How often positions are recorded, from `PALSENTRY_WAYBACK_INTERVAL_SECONDS`. */
  intervalSeconds: number;
}

interface PointRow {
  userid: string;
  ts: number;
  x: number;
  y: number;
}

interface SnapshotRow {
  ts: number;
  playerCount: number;
}

export class PlayerHistoryService {
  private readonly db: Db;
  private readonly players: PlayerService;
  private readonly logger: Logger;
  private readonly retentionDays: number;
  private readonly cadenceSeconds: number;

  private sampleTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  /** The observation currently in flight, so `stop()` can wait for its write before the DB closes. */
  private inflight: Promise<boolean> | null = null;

  constructor(options: PlayerHistoryServiceOptions) {
    this.db = options.db;
    this.players = options.players;
    this.logger = options.logger;
    this.retentionDays = options.retentionDays;
    this.cadenceSeconds = options.intervalSeconds;
  }

  // -------------------------------------------------------------------------
  // Recording cadence
  // -------------------------------------------------------------------------

  /** The cadence recordings are taken at, in seconds. Fixed for the life of the process. */
  get intervalSeconds(): number {
    return this.cadenceSeconds;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin recording, and resolve once the first observation has been written.
   *
   * Like the metrics poller, timers are installed before the first observation is awaited so a
   * slow game server cannot delay the schedule, and this only runs from the real entrypoint —
   * tests call `observe()` directly rather than acquiring background timers.
   */
  async start(): Promise<void> {
    if (this.sampleTimer !== null) return;

    this.prune();

    this.sampleTimer = setInterval(() => {
      void this.observe();
    }, this.cadenceSeconds * 1_000);
    this.sampleTimer.unref();

    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();

    this.logger.info(
      { intervalSeconds: this.cadenceSeconds, retentionDays: this.retentionDays },
      'Wayback recorder started',
    );

    await this.observe();
  }

  /** Stop recording, waiting for any in-flight write so shutdown cannot race it. */
  async stop(): Promise<void> {
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    try {
      await this.inflight;
    } catch {
      // `observe()` does not reject, but never let shutdown hinge on that.
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Take one observation and store it.
   *
   * Never rejects: an unreachable game server is an ordinary event, and a gap in the history is
   * the correct outcome. Concurrent calls share one observation rather than writing twice.
   */
  async observe(): Promise<boolean> {
    if (this.inflight !== null) return this.inflight;

    const promise = this.takeObservation().finally(() => {
      this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  private async takeObservation(): Promise<boolean> {
    const snapshot = await this.players.refresh();

    if (!snapshot.ok) {
      // Nothing is written, so the trail breaks here instead of jumping across the outage.
      // PlayerService already warned about the outage itself; this is the history-specific
      // consequence and belongs at debug level.
      this.logger.debug('Wayback observation failed; movement history will have a gap');
      return false;
    }

    return this.recordSnapshot(snapshot) !== null;
  }

  /**
   * Store one successful observation, atomically.
   *
   * Returns the new snapshot id, or null when nothing was written — either because the read
   * failed or because this exact second is already recorded (which can only happen across a
   * restart, where the previous process may have sampled in the same second).
   */
  recordSnapshot(snapshot: PlayerSnapshot): number | null {
    if (!snapshot.ok) return null;

    const capturedAt = Math.floor(Date.parse(snapshot.observedAt) / 1_000);
    if (!Number.isFinite(capturedAt)) {
      this.logger.warn(
        { observedAt: snapshot.observedAt },
        'Wayback observation had no usable time',
      );
      return null;
    }

    const insertSnapshot = this.db.prepare(
      `INSERT INTO player_position_snapshots (captured_at, player_count)
       VALUES (@capturedAt, @playerCount)
       ON CONFLICT(captured_at) DO NOTHING`,
    );
    const insertPosition = this.db.prepare(
      `INSERT INTO player_positions
         (snapshot_id, captured_at, userid, name, level, location_x, location_y)
       VALUES
         (@snapshotId, @capturedAt, @userid, @name, @level, @locationX, @locationY)`,
    );

    // One transaction for the observation and its positions: a snapshot row without its players
    // would claim the server was empty, which is a different fact entirely.
    const write = this.db.transaction(
      (at: number, players: readonly PalworldPlayer[]): number | null => {
        const inserted = insertSnapshot.run({ capturedAt: at, playerCount: players.length });
        if (inserted.changes === 0) return null;

        const snapshotId = Number(inserted.lastInsertRowid);
        for (const player of players) {
          insertPosition.run({
            snapshotId,
            capturedAt: at,
            userid: player.userId,
            name: player.name,
            level: player.level,
            locationX: player.location_x,
            locationY: player.location_y,
          });
        }
        return snapshotId;
      },
    );

    return write(capturedAt, snapshot.players);
  }

  /**
   * Delete history beyond the retention window.
   *
   * `now` is injectable so the retention boundary can be tested at a fixed instant instead of
   * only against the wall clock.
   */
  prune(now: number = Date.now()): number {
    try {
      const removed = prunePlayerHistory(this.db, this.retentionDays, now);
      if (removed > 0) {
        this.logger.debug(
          { removed, retentionDays: this.retentionDays },
          'Pruned old player position history',
        );
      }
      return removed;
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to prune player position history');
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Recorded movement for a rolling preset or an explicit absolute range.
   *
   * Everything a single selected instant needs is in the response, so scrubbing the timeline is a
   * client-side operation: one request per range, not one per pointer movement.
   *
   * The response is downsampled to one observation per bucket, per player:
   *
   * - **Ticks** are the last successful snapshot in each bucket, kept at its real timestamp so a
   *   selected instant always names an observation that actually happened.
   * - **Points** are each player's last observation in each bucket, also at its real timestamp.
   *
   * Because both keep the *last* row of a bucket, a player who appears in a tick's snapshot
   * necessarily has a point with that exact timestamp. That equality is what the UI uses to
   * decide whether a player was online at the selected instant, and it stays correct without the
   * server having to send a per-tick roster.
   */
  history(
    requested: HistorySelection | HistoryWindow = {
      kind: 'window',
      window: DEFAULT_WAYBACK_WINDOW,
    },
    now: number = Date.now(),
  ): PlayerHistoryResponse {
    const { selection, window, from, to, bucketSeconds, anchor } = resolveHistoryRange(requested, {
      retentionDays: this.retentionDays,
      sampleIntervalSeconds: this.cadenceSeconds,
      now,
      // Custom ranges are the timeline's zoom level, so they resolve to the finest bucket the
      // configured cadence and the point cap allow. Preset windows keep their chart buckets.
      customBucketSeconds: waybackBucketSeconds,
    });

    const parameters = { anchor, bucket: bucketSeconds, from, to };

    const snapshotRows = this.db
      .prepare(
        `SELECT ts, player_count AS playerCount
           FROM (
             SELECT captured_at AS ts,
                    player_count,
                    ROW_NUMBER() OVER (
                      PARTITION BY CAST((captured_at - @anchor) / @bucket AS INTEGER)
                      ORDER BY captured_at DESC
                    ) AS rank
               FROM player_position_snapshots
              WHERE captured_at >= @from
                AND captured_at <= @to
                -- Rows synthesised from the pre-upgrade roster are usable history but were never
                -- observed by this service, so they must not appear as timeline ticks.
                AND synthetic = 0
           )
          WHERE rank = 1
          ORDER BY ts`,
      )
      .all(parameters) as SnapshotRow[];

    const pointRows = this.db
      .prepare(
        `SELECT userid, ts, x, y
           FROM (
             SELECT userid,
                    captured_at AS ts,
                    location_x  AS x,
                    location_y  AS y,
                    ROW_NUMBER() OVER (
                      PARTITION BY userid, CAST((captured_at - @anchor) / @bucket AS INTEGER)
                      ORDER BY captured_at DESC
                    ) AS rank
               FROM player_positions
              WHERE captured_at >= @from
                AND captured_at <= @to
           )
          WHERE rank = 1
          ORDER BY userid, ts`,
      )
      .all(parameters) as PointRow[];

    const pointsByUser = new Map<string, WaybackPoint[]>();
    for (const row of pointRows) {
      const points = pointsByUser.get(row.userid);
      const point: WaybackPoint = { ts: row.ts, x: row.x, y: row.y };
      if (points === undefined) pointsByUser.set(row.userid, [point]);
      else points.push(point);
    }

    const players: WaybackPlayerHistory[] = [];
    const known = new Set<string>();
    for (const entry of this.players.list()) {
      if (players.length >= MAX_HISTORY_PLAYERS) break;

      known.add(entry.userId);
      const points = pointsByUser.get(entry.userId) ?? [];

      // A roster account with nothing recorded in the range cannot be drawn at any instant in it,
      // so it is left out entirely; the live Players tab is where accounts are enumerated.
      if (points.length === 0) continue;

      players.push({ userId: entry.userId, name: entry.name, points });
    }

    // Positions are only ever written for accounts the roster already knows, so a recorded
    // account the roster cannot name is a real inconsistency rather than an expected state.
    // Saying so beats silently hiding someone's movement from the map.
    for (const userid of pointsByUser.keys()) {
      if (!known.has(userid)) {
        this.logger.warn(
          { userid },
          'Recorded wayback positions have no roster entry; that account is missing from the map',
        );
      }
    }

    return {
      selection,
      window,
      from,
      to,
      bucketSeconds,
      snapshots: snapshotRows.map<WaybackSnapshot>((row) => ({
        ts: row.ts,
        playerCount: row.playerCount,
      })),
      players,
    };
  }

  /** Total observations stored, for diagnostics. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM player_position_snapshots').get() as {
      n: number;
    };
    return row.n;
  }
}
