import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_MAX_POINTS,
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

/**
 * Background sampler that turns the Palworld API's point-in-time `/metrics` snapshot into a
 * time series.
 *
 * The REST API keeps no history, so without this the performance charts have nothing to draw.
 * Sampling is intentionally coarse (`PALSENTRY_SAMPLE_INTERVAL_SECONDS`, default 60s): the goal
 * is spotting lag spikes and peak hours, not high-resolution telemetry, and every sample is a
 * request the game server has to serve.
 */

/** Window definitions, and how far each is downsampled. */
const WINDOW_SECONDS: Record<HistoryWindow, number> = {
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

/**
 * Bucket size per window, chosen to yield a few hundred points.
 *
 * More than that is wasted on a chart a few hundred pixels wide, and fewer makes a lag spike
 * invisible. Buckets are never finer than the sample interval, since that would just interleave
 * empty buckets.
 */
const BUCKET_SECONDS: Record<HistoryWindow, number> = {
  '1h': 60,
  '6h': 120,
  '24h': 300,
  '7d': 1800,
  '30d': 7200,
};

const CUSTOM_BUCKET_TIERS: readonly { maximumSpan: number; bucketSeconds: number }[] = [
  { maximumSpan: WINDOW_SECONDS['1h'], bucketSeconds: BUCKET_SECONDS['1h'] },
  { maximumSpan: WINDOW_SECONDS['6h'], bucketSeconds: BUCKET_SECONDS['6h'] },
  { maximumSpan: WINDOW_SECONDS['24h'], bucketSeconds: BUCKET_SECONDS['24h'] },
  { maximumSpan: WINDOW_SECONDS['7d'], bucketSeconds: BUCKET_SECONDS['7d'] },
  { maximumSpan: WINDOW_SECONDS['30d'], bucketSeconds: BUCKET_SECONDS['30d'] },
];

/** Round up to a compact 1/2/5 × 10ⁿ progression. */
function niceBucketCeiling(seconds: number): number {
  const safe = Math.max(1, Math.ceil(seconds));
  const magnitude = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

/** Choose a bounded custom-range bucket while retaining familiar buckets for ranges up to 30d. */
export function customHistoryBucketSeconds(
  spanSeconds: number,
  sampleIntervalSeconds: number,
): number {
  const span = Number.isFinite(spanSeconds) ? Math.max(1, Math.ceil(spanSeconds)) : 1;
  const interval = Number.isFinite(sampleIntervalSeconds)
    ? Math.max(1, Math.ceil(sampleIntervalSeconds))
    : 1;
  const tier = CUSTOM_BUCKET_TIERS.find(({ maximumSpan }) => span <= maximumSpan);
  if (tier !== undefined) return Math.max(interval, tier.bucketSeconds);

  return Math.max(interval, niceBucketCeiling(span / HISTORY_MAX_POINTS));
}

interface HistoryRow {
  bucket_ts: number;
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
   */
  history(
    requested: HistorySelection | HistoryWindow = {
      kind: 'window',
      window: DEFAULT_HISTORY_WINDOW,
    },
    now: number = Date.now(),
  ): HistoryResponse {
    const selection: HistorySelection =
      typeof requested === 'string' ? { kind: 'window', window: requested } : requested;
    const to = selection.kind === 'window' ? Math.floor(now / 1_000) : Math.floor(selection.to);
    const from =
      selection.kind === 'window'
        ? to - WINDOW_SECONDS[selection.window]
        : Math.floor(selection.from);

    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new RangeError('History boundaries must be ordered positive Unix-second integers.');
    }

    const spanSeconds = to - from;
    if (selection.kind === 'range' && spanSeconds > this.retentionDays * 24 * 60 * 60) {
      throw new RangeError('History range exceeds the configured retention period.');
    }

    const bucketSeconds =
      selection.kind === 'window'
        ? BUCKET_SECONDS[selection.window]
        : customHistoryBucketSeconds(spanSeconds, this.intervalSeconds);
    // Presets retain their established epoch-aligned buckets. Custom buckets start at the exact
    // requested boundary so the first chart point never predates the selected range.
    const anchor = selection.kind === 'range' ? from : 0;

    const rows = this.db
      .prepare(
        `SELECT
           @anchor + CAST((ts - @anchor) / @bucket AS INTEGER) * @bucket AS bucket_ts,
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

    const samples: HistorySample[] = rows.map((row) => ({
      ts: row.bucket_ts,
      serverfps: Math.round(row.serverfps),
      currentplayernum: Math.round(row.currentplayernum),
      maxplayernum: row.maxplayernum,
      // One decimal is plenty for a millisecond frame time and keeps the payload small.
      serverframetime: Math.round(row.serverframetime * 10) / 10,
      uptime: row.uptime,
      basecampnum: Math.round(row.basecampnum),
      days: row.days,
    }));

    return {
      selection,
      window: selection.kind === 'window' ? selection.window : null,
      from,
      to,
      bucketSeconds,
      samples,
    };
  }

  /** Total samples stored, for diagnostics. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as { n: number };
    return row.n;
  }
}
