import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_MAX_POINTS,
  type HistorySelection,
  type HistoryWindow,
} from '@palsentry/shared';

/**
 * Turning a requested history range into the boundaries and bucket size a query needs.
 *
 * Both time series PalSentry keeps — metric samples and, later, player positions — answer the same
 * question ("what happened between these two instants, at a resolution the browser can draw?"),
 * so the rules live here rather than being duplicated per service. The numbers are deliberately
 * shared: a chart and a map showing the same range should agree on how much detail that range
 * deserves.
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

/** The smallest multiple of `multiple` that is at least `value`. */
function roundUpToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
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

/**
 * Bucket size for an explicit wayback range.
 *
 * Wayback is scrubbed rather than read as a chart, so its custom ranges are the zoom level: a
 * two-minute view must expose the configured observations instead of one 60-second column. This
 * therefore picks the finest bucket the point cap allows — always a whole multiple of the
 * recording cadence, so buckets line up with observations and never subdivide them — while wide
 * ranges keep the familiar chart tiers whenever those are already within the cap.
 */
export function waybackBucketSeconds(spanSeconds: number, sampleIntervalSeconds: number): number {
  const span = Number.isFinite(spanSeconds) ? Math.max(1, Math.ceil(spanSeconds)) : 1;
  const interval = Number.isFinite(sampleIntervalSeconds)
    ? Math.max(1, Math.ceil(sampleIntervalSeconds))
    : 1;
  const fitted = niceBucketCeiling(span / HISTORY_MAX_POINTS);
  const tier = CUSTOM_BUCKET_TIERS.find(({ maximumSpan }) => span <= maximumSpan);
  const baseline = tier === undefined ? fitted : Math.min(tier.bucketSeconds, fitted);

  return roundUpToMultiple(baseline, interval);
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
     * Custom-range bucketing. Defaults to the shared chart tiers; the wayback map passes
     * {@link waybackBucketSeconds} so its custom ranges are the zoom level rather than a chart.
     */
    customBucketSeconds?: (spanSeconds: number, sampleIntervalSeconds: number) => number;
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

  const customBucket = options.customBucketSeconds ?? customHistoryBucketSeconds;
  const bucketSeconds =
    selection.kind === 'window'
      ? BUCKET_SECONDS[selection.window]
      : customBucket(spanSeconds, options.sampleIntervalSeconds);

  return {
    selection,
    window: selection.kind === 'window' ? selection.window : null,
    from,
    to,
    bucketSeconds,
    anchor: selection.kind === 'range' ? from : 0,
  };
}
