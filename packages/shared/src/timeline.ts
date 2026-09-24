/**
 * Viewport maths for the wayback timeline.
 *
 * The timeline is a time *camera*: `from`/`to` are the instants at the left and right edges of the
 * track, exactly like the map's camera bounds. Keeping that arithmetic here — pure, integer, and
 * DOM-free — means pointer-anchored zoom and panning can be tested in the server workspace, which
 * has a test runner, rather than only through browser gestures.
 *
 * Every helper is total: invalid, reversed, or out-of-bounds input produces a usable range inside
 * the bounds instead of throwing, because a gesture that goes wrong must not be able to break the
 * view.
 */

/** A visible time range in integer Unix seconds; `to` is exclusive in the zoom sense but the UI
 * treats both edges as reachable instants. */
export interface TimeRange {
  from: number;
  to: number;
}

/** The instants a viewport is allowed to cover: retained history through the present. */
export type TimeBounds = TimeRange;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The smallest span the timeline may show, in seconds.
 *
 * Sixty seconds keeps the track readable when the recording cadence is fine, while two cadence
 * steps guarantee that a zoomed-in view can always show two adjacent observations rather than a
 * single one filling the track.
 */
export function minimumTimelineSpanSeconds(intervalSeconds: number): number {
  const interval = Math.max(1, Math.ceil(finiteOr(intervalSeconds, 1)));
  return Math.max(60, interval * 2);
}

/** The visible span in seconds. Always a positive integer for a valid range. */
export function timelineSpan(range: TimeRange): number {
  return range.to - range.from;
}

/**
 * Fit a range inside `bounds`, honouring a minimum span.
 *
 * The requested end is kept where possible (zoom gestures feel anchored to the right edge), and a
 * range wider than the bounds is trimmed rather than slid, so "show me everything" still works.
 */
export function clampTimelineRange(
  range: TimeRange,
  bounds: TimeBounds,
  minSpanSeconds = 1,
): TimeRange {
  const boundFrom = Math.floor(finiteOr(bounds.from, 0));
  const boundTo = Math.max(boundFrom + 1, Math.floor(finiteOr(bounds.to, boundFrom + 1)));
  const totalSpan = boundTo - boundFrom;
  const minSpan = Math.min(totalSpan, Math.max(1, Math.ceil(finiteOr(minSpanSeconds, 1))));

  let from = Math.floor(finiteOr(range.from, boundFrom));
  const to = Math.floor(finiteOr(range.to, from + minSpan));
  const span = Math.min(totalSpan, Math.max(minSpan, to - from));

  // Keep the requested end, then slide the whole window inside the bounds. Sliding preserves the
  // span, and because `span <= totalSpan` at most one of these can apply.
  if (from < boundFrom) from = boundFrom;
  let end = from + span;
  if (end > boundTo) {
    end = boundTo;
    from = end - span;
  }

  return { from, to: end };
}

/** Shift a range by `deltaSeconds` without changing its span. */
export function panTimelineRange(
  range: TimeRange,
  deltaSeconds: number,
  bounds: TimeBounds,
  minSpanSeconds = 1,
): TimeRange {
  const delta = Math.round(finiteOr(deltaSeconds, 0));
  return clampTimelineRange(
    { from: range.from + delta, to: range.to + delta },
    bounds,
    minSpanSeconds,
  );
}

/**
 * Zoom to `targetSpanSeconds` while keeping the instant under `anchorFraction` stationary.
 *
 * `anchorFraction` is the pointer's position across the track: 0 at the left edge, 1 at the right.
 * This is what makes wheel and pinch zoom feel like they are pulling the timeline towards the
 * cursor rather than the centre of the view.
 */
export function zoomTimelineRangeAt(
  range: TimeRange,
  targetSpanSeconds: number,
  anchorFraction: number,
  bounds: TimeBounds,
  minSpanSeconds = 1,
): TimeRange {
  const current = clampTimelineRange(range, bounds, minSpanSeconds);
  const currentSpan = timelineSpan(current);
  const fraction = clamp01(finiteOr(anchorFraction, 0.5));
  const targetSpan = Math.max(1, Math.ceil(finiteOr(targetSpanSeconds, currentSpan)));
  const anchoredAt = current.from + fraction * currentSpan;
  const from = Math.round(anchoredAt - fraction * targetSpan);

  return clampTimelineRange({ from, to: from + targetSpan }, bounds, minSpanSeconds);
}

/** True when `ts` falls inside the visible range. */
export function timelineContains(range: TimeRange, ts: number): boolean {
  return Number.isFinite(ts) && ts >= range.from && ts <= range.to;
}

/** Where `ts` sits across the track: 0 at the left edge, 1 at the right. */
export function timelineFractionAt(range: TimeRange, ts: number): number {
  const span = timelineSpan(range);
  if (!Number.isFinite(span) || span <= 0) return 0;
  return (ts - range.from) / span;
}

/** The instant at `fraction` across the track. */
export function timelineTimeAt(range: TimeRange, fraction: number): number {
  return range.from + clamp01(finiteOr(fraction, 0)) * timelineSpan(range);
}

/**
 * The recorded instant closest to `target`, or null when there is nothing to snap to.
 *
 * `values` is expected to be sorted ascending, which is how the history endpoint returns
 * snapshots. Binary search keeps this cheap for a dense range without assuming a small one.
 */
export function nearestTimestamp(values: readonly number[], target: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(target)) return values[0] ?? null;

  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? 0) < target) low = middle + 1;
    else high = middle;
  }

  const candidate = values[low] ?? 0;
  const previous = low > 0 ? (values[low - 1] ?? candidate) : null;
  if (previous === null) return candidate;
  return target - previous <= candidate - target ? previous : candidate;
}

/**
 * Where playback begins when play is pressed.
 *
 * Wayback opens on the live tail, where there is nothing ahead to play, so that case starts from
 * the oldest loaded observation rather than stopping on the first tick. Anywhere else the playhead
 * itself is the starting point: the moment already on screen is not skipped, and the first step
 * advances from it.
 */
export function playbackStartIndex(currentIndex: number | null, lastIndex: number): number {
  const last = Math.max(0, Math.floor(finiteOr(lastIndex, 0)));
  if (currentIndex === null) return 0;

  const index = Math.floor(finiteOr(currentIndex, 0));
  return index <= 0 || index >= last ? 0 : index;
}

/**
 * The index one playback step lands on, or null when the step would pass the loaded observations.
 *
 * Null is the caller's cue to load more history — or, at the live edge where there is none yet, to
 * hold on the newest observation until the next one is recorded. A step never lands between two
 * observations: the returned index is always a real one, or nothing at all.
 */
export function nextPlaybackIndex(
  currentIndex: number,
  steps: number,
  lastIndex: number,
): number | null {
  const last = Math.max(0, Math.floor(finiteOr(lastIndex, 0)));
  const index = Math.min(last, Math.max(0, Math.floor(finiteOr(currentIndex, 0))));
  const advance = Math.max(1, Math.floor(finiteOr(steps, 1)));
  const next = index + advance;

  return next > last ? null : next;
}
