import {
  DEFAULT_HISTORY_WINDOW,
  type HistoryResponse,
  type HistorySample,
  type HistorySelection,
  type HistoryWindow,
} from '@palsentry/shared';
import type { Db } from '../db/index.js';
import { pruneMetricSamples } from '../db/migrations.js';
import type { Logger } from '../logger.js';
import { PalworldError } from '../palworld/errors.js';
import type { PalworldClient } from '../palworld/client.js';
import { resolveHistoryRange } from './history-range.js';

/**
 * Background sampler that turns the Palworld API's point-in-time `/metrics` snapshot into a
 * time series.
 *
 * The REST API keeps no history, so without this the performance charts have nothing to draw.
 * Sampling is intentionally coarse (`PALSENTRY_SAMPLE_INTERVAL_SECONDS`, default 60s): the goal
 * is spotting lag spikes and peak hours, not high-resolution telemetry, and every sample is a
 * request the game server has to serve.
 */

interface HistoryRow {
  bucket_ts: number;
  /**
   * Newest sample inside the bucket.
   *
   * Not part of the response: it is the anchor for the optional online-name lookup, because the
   * names should describe the moment the bucket's own data ends at rather than its start.
   */
  last_ts: number;
  serverfps: number;
  currentplayernum: number;
  maxplayernum: number;
  serverframetime: number;
  uptime: number;
  basecampnum: number;
  days: number;
}

/** How often retention pruning runs while the process is up. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class MetricsPoller {
  private readonly db: Db;
  private readonly client: PalworldClient;
  private readonly logger: Logger;
  private readonly intervalSeconds: number;
  private readonly retentionDays: number;

  private sampleTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  /** The sample currently in flight, so `stop()` can wait for it before the DB closes. */
  private inflight: Promise<boolean> | null = null;

  constructor(options: {
    db: Db;
    client: PalworldClient;
    logger: Logger;
    intervalSeconds: number;
    retentionDays: number;
  }) {
    this.db = options.db;
    this.client = options.client;
    this.logger = options.logger;
    this.intervalSeconds = options.intervalSeconds;
    this.retentionDays = options.retentionDays;
  }

  /**
   * Begin sampling, and resolve once the first sample has been taken.
   *
   * Timers are installed *before* the first sample is awaited, so a slow or hanging game server
   * cannot delay the sampling schedule. The returned promise is what lets callers (and tests)
   * know the first row is in the database.
   */
  async start(): Promise<void> {
    if (this.sampleTimer !== null) return;

    this.prune();

    this.sampleTimer = setInterval(() => {
      void this.sample();
    }, this.intervalSeconds * 1000);
    // Do not hold the event loop open on this account alone.
    this.sampleTimer.unref();

    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();

    this.logger.info(
      { intervalSeconds: this.intervalSeconds, retentionDays: this.retentionDays },
      'Metrics poller started',
    );

    await this.sample();
  }

  /**
   * Stop sampling, waiting for any in-flight sample to finish.
   *
   * The wait matters on shutdown: closing SQLite while a sample write is in flight would throw
   * from a timer callback with nothing left to catch it.
   */
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
      // `sample()` does not reject, but never let shutdown hinge on that.
    }
  }

  /**
   * Take one sample.
   *
   * Never throws: a failure is an ordinary event here (the game server restarts, gets
   * overloaded, or is switched off) and must not disrupt the poller or spam the log.
   * Concurrent calls share one in-flight request rather than stacking up.
   */
  async sample(): Promise<boolean> {
    if (this.inflight !== null) return this.inflight;

    const promise = this.takeSample().finally(() => {
      this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  private async takeSample(): Promise<boolean> {
    try {
      const metrics = await this.client.metrics();

      // Replace rather than insert: `ts` is the primary key and is second-granular, so a manual
      // sample in the same second as a scheduled one would otherwise violate the key.
      this.db
        .prepare(
          `INSERT INTO metric_samples
             (ts, serverfps, currentplayernum, maxplayernum, serverframetime, uptime, basecampnum, days)
           VALUES
             (@ts, @serverfps, @currentplayernum, @maxplayernum, @serverframetime, @uptime, @basecampnum, @days)
           ON CONFLICT(ts) DO UPDATE SET
             serverfps        = excluded.serverfps,
             currentplayernum = excluded.currentplayernum,
             maxplayernum     = excluded.maxplayernum,
             serverframetime  = excluded.serverframetime,
             uptime           = excluded.uptime,
             basecampnum      = excluded.basecampnum,
             days             = excluded.days`,
        )
        .run({
          ts: Math.floor(Date.now() / 1000),
          serverfps: Math.round(metrics.serverfps),
          currentplayernum: metrics.currentplayernum,
          maxplayernum: metrics.maxplayernum,
          serverframetime: metrics.serverframetime,
          uptime: metrics.uptime,
          basecampnum: metrics.basecampnum,
          days: metrics.days,
        });

      if (this.consecutiveFailures > 0) {
        this.logger.info({ afterFailures: this.consecutiveFailures }, 'Metrics sampling recovered');
        this.consecutiveFailures = 0;
      }
      return true;
    } catch (error) {
      this.consecutiveFailures += 1;
      const detail = error instanceof PalworldError ? error.message : String(error);

      // Warn on the first failure so an outage is visible, then drop to debug — a server that is
      // off for hours should not fill the log with one line per minute.
      if (this.consecutiveFailures === 1) {
        this.logger.warn(
          { reason: detail },
          'Metrics sample failed; monitoring data will have a gap',
        );
      } else {
        this.logger.debug(
          { reason: detail, consecutiveFailures: this.consecutiveFailures },
          'Metrics sample still failing',
        );
      }
      return false;
    }
  }

  /** Delete samples beyond the retention window. */
  prune(): number {
    try {
      const removed = pruneMetricSamples(this.db, this.retentionDays);
      if (removed > 0) {
        this.logger.debug(
          { removed, retentionDays: this.retentionDays },
          'Pruned old metric samples',
        );
      }
      return removed;
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to prune metric samples');
      return 0;
    }
  }

  /**
   * Downsampled history for a rolling preset or explicit absolute range.
   *
   * Aggregation happens in SQL rather than in the browser so a long retention period does not
   * ship tens of thousands of rows over the wire. Averages are used for rates and `MAX` for the
   * counters that represent high-water marks within the bucket.
   *
   * `includePlayers` additionally names who was online in each bucket. It costs one indexed lookup
   * per bucket, so it is opt-in rather than part of every history response: only the Players online
   * chart shows names, and the other three charts should not pay for them.
   */
  history(
    requested: HistorySelection | HistoryWindow = {
      kind: 'window',
      window: DEFAULT_HISTORY_WINDOW,
    },
    now: number = Date.now(),
    options: { includePlayers?: boolean } = {},
  ): HistoryResponse {
    const { selection, window, from, to, bucketSeconds, anchor } = resolveHistoryRange(requested, {
      retentionDays: this.retentionDays,
      sampleIntervalSeconds: this.intervalSeconds,
      now,
    });

    const rows = this.db
      .prepare(
        `SELECT
           @anchor + CAST((ts - @anchor) / @bucket AS INTEGER) * @bucket AS bucket_ts,
           MAX(ts)             AS last_ts,
           AVG(serverfps)        AS serverfps,
           AVG(currentplayernum) AS currentplayernum,
           MAX(maxplayernum)     AS maxplayernum,
           AVG(serverframetime)  AS serverframetime,
           MAX(uptime)           AS uptime,
           AVG(basecampnum)      AS basecampnum,
           MAX(days)             AS days
         FROM metric_samples
         WHERE ts >= @from AND ts <= @to
         GROUP BY bucket_ts
         ORDER BY bucket_ts`,
      )
      .all({ anchor, bucket: bucketSeconds, from, to }) as HistoryRow[];

    const names = options.includePlayers === true ? this.namesByBucket(rows) : null;

    const samples: HistorySample[] = rows.map((row) => {
      const sample: HistorySample = {
        ts: row.bucket_ts,
        serverfps: Math.round(row.serverfps),
        currentplayernum: Math.round(row.currentplayernum),
        maxplayernum: row.maxplayernum,
        // One decimal is plenty for a millisecond frame time and keeps the payload small.
        serverframetime: Math.round(row.serverframetime * 10) / 10,
        uptime: row.uptime,
        basecampnum: Math.round(row.basecampnum),
        days: row.days,
      };

      const online = names?.get(row.bucket_ts);
      if (online !== undefined) sample.onlinePlayers = online;

      return sample;
    });

    return {
      selection,
      window,
      from,
      to,
      bucketSeconds,
      samples,
    };
  }

  /**
   * Who was online at the end of each bucket, from the wayback recorder's observations.
   *
   * The position history is the only record PalSentry keeps of *who* was connected at a moment;
   * `metric_samples` counts them but does not know their names. Both tables belong to this database
   * and the recorder writes every cadence step, so a bucket's newest sample has an observation
   * within seconds of it.
   *
   * The lookup is deliberately confined to the bucket: a bucket that covers an outage — or one
   * older than the recorder's history — is left out entirely rather than attributing the last
   * roster seen before the gap to it. Synthesised pre-upgrade rows are excluded for the same reason
   * they are excluded from the timeline: this service never observed them.
   *
   * A bucket whose observation saw nobody maps to an empty list, which is a different fact from a
   * bucket with no observation at all.
   */
  private namesByBucket(rows: readonly HistoryRow[]): Map<number, string[]> {
    // The LEFT JOIN is what separates the two cases: no observation yields no row at all, while an
    // observation of an empty world yields one row whose name is NULL. DISTINCT collapses two
    // accounts that share a display name, which is all the chart can show anyway.
    const statement = this.db.prepare(
      `SELECT DISTINCT p.name AS name
         FROM (SELECT s.id
                 FROM player_position_snapshots s
                WHERE s.captured_at >= @bucketStart
                  AND s.captured_at <= @upto
                  AND s.synthetic = 0
                ORDER BY s.captured_at DESC
                LIMIT 1) observed
         LEFT JOIN player_positions p ON p.snapshot_id = observed.id
        ORDER BY p.name`,
    );

    const byBucket = new Map<number, string[]>();
    for (const row of rows) {
      const found = statement.all({ bucketStart: row.bucket_ts, upto: row.last_ts }) as {
        name: string | null;
      }[];
      if (found.length === 0) continue;

      byBucket.set(
        row.bucket_ts,
        found.map((entry) => entry.name).filter((name): name is string => name !== null),
      );
    }

    return byBucket;
  }

  /** Total samples stored, for diagnostics. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as { n: number };
    return row.n;
  }
}
