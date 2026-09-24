import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_MAX_POINTS,
  WAYBACK_MAX_POINTS,
  type HistorySelection,
  type HistoryWindow,
} from '@palsentry/shared';

/**
 * Turning a requested history range into the boundaries and bucket size a query needs.
 *
 * Both time series PalSentry keeps — metric samples and player positions — answer the same
 * question ("what happened between these two instants, at a resolution the browser can draw?"),
 * so the rules live here rather than being duplicated per service. What differs is the budget:
 * a chart is read, so its buckets only need to be as fine as the graph is wide, while the wayback
 * timeline is scrubbed, so its buckets are also its steps and deserve as much detail as the
 * payload can carry. Either way the widest range resolves to a bounded number of buckets, which is
 * what keeps both drawable.
 */

/** Window definitions in seconds. */
export const WINDOW_SECONDS: Record<HistoryWindow, number> = {
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

const BUCKET_TIERS: readonly { maximumSpan: number; bucketSeconds: number }[] = [
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

/** The smallest multiple of `multiple` that is at least `value`. */
function roundUpToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

/**
 * Bucket size for a chart, or any range read rather than scrubbed.
 *
 * Familiar buckets for ranges up to 30 days — the same hour looks the same on every reload — and a
 * bounded bucket beyond them. Buckets are never finer than the sample interval, since that would
 * only interleave empty buckets, which is why this is also the strategy preset windows use.
 */
export function chartBucketSeconds(spanSeconds: number, sampleIntervalSeconds: number): number {
  const span = Number.isFinite(spanSeconds) ? Math.max(1, Math.ceil(spanSeconds)) : 1;
  const interval = Number.isFinite(sampleIntervalSeconds)
    ? Math.max(1, Math.ceil(sampleIntervalSeconds))
    : 1;
  const tier = BUCKET_TIERS.find(({ maximumSpan }) => span <= maximumSpan);
  if (tier !== undefined) return Math.max(interval, tier.bucketSeconds);

  return Math.max(interval, niceBucketCeiling(span / HISTORY_MAX_POINTS));
}

/**
 * Bucket size for the wayback timeline, whatever form its selection takes.
 *
 * Wayback is scrubbed rather than read as a chart, so its ranges are a zoom level: a two-minute
 * view must expose the configured observations instead of one 60-second column. This therefore
 * picks the finest bucket {@link WAYBACK_MAX_POINTS} allows — always a whole multiple of the
 * recording cadence, so buckets line up with observations and never subdivide them — and applies
 * to preset windows exactly as it does to custom ranges, because the last hour deserves the same
 * detail whether it was chosen from the list or dragged into view.
 */
export function waybackBucketSeconds(spanSeconds: number, sampleIntervalSeconds: number): number {
  const span = Number.isFinite(spanSeconds) ? Math.max(1, Math.ceil(spanSeconds)) : 1;
  const interval = Number.isFinite(sampleIntervalSeconds)
    ? Math.max(1, Math.ceil(sampleIntervalSeconds))
    : 1;

  return roundUpToMultiple(niceBucketCeiling(span / WAYBACK_MAX_POINTS), interval);
}

/** A validated range, with the bucket grid every point in the response was folded onto. */
export interface ResolvedHistoryRange {
  /** The requested selection, normalized to the explicit form. */
  selection: HistorySelection;
  /** Preset compatibility field; null for an explicit custom range. */
  window: HistoryWindow | null;
  /** Inclusive Unix-second boundaries. */
  from: number;
  to: number;
  bucketSeconds: number;
  /**
   * Bucket grid origin.
   *
   * Presets keep their established epoch-aligned buckets, so the same hour looks the same on
   * every reload. Custom buckets start at the requested boundary instead, so the first point can
   * never predate the range the operator asked for.
   */
  anchor: number;
}

/**
 * Validate a selection and resolve it against the clock.
 *
 * Throws a `RangeError` for anything the caller must fix: unset boundaries, reversed ranges, and
 * ranges longer than the retention window (which cannot be served truthfully anyway, because the
 * data has been pruned).
 */
export function resolveHistoryRange(
  requested: HistorySelection | HistoryWindow = {
    kind: 'window',
    window: DEFAULT_HISTORY_WINDOW,
  },
  options: {
    retentionDays: number;
    sampleIntervalSeconds: number;
    now?: number;
    /**
     * Bucketing strategy, applied to preset and custom selections alike.
     *
     * Defaults to {@link chartBucketSeconds}; the wayback map passes
     * {@link waybackBucketSeconds} so its ranges are the zoom level rather than a chart.
     */
    bucketSeconds?: (spanSeconds: number, sampleIntervalSeconds: number) => number;
  },
): ResolvedHistoryRange {
  const selection: HistorySelection =
    typeof requested === 'string' ? { kind: 'window', window: requested } : requested;
  const now = options.now ?? Date.now();

  const to = selection.kind === 'window' ? Math.floor(now / 1_000) : Math.floor(selection.to);
  const from =
    selection.kind === 'window'
      ? to - WINDOW_SECONDS[selection.window]
      : Math.floor(selection.from);

  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new RangeError('History boundaries must be ordered positive Unix-second integers.');
  }

  const spanSeconds = to - from;
  if (selection.kind === 'range' && spanSeconds > options.retentionDays * 24 * 60 * 60) {
    throw new RangeError('History range exceeds the configured retention period.');
  }

  const bucketStrategy = options.bucketSeconds ?? chartBucketSeconds;
  const bucketSeconds = bucketStrategy(spanSeconds, options.sampleIntervalSeconds);

  return {
    selection,
    window: selection.kind === 'window' ? selection.window : null,
    from,
    to,
    bucketSeconds,
    anchor: selection.kind === 'range' ? from : 0,
  };
}
