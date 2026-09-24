import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampTimelineRange,
  minimumTimelineSpanSeconds,
  nearestTimestamp,
  panTimelineRange,
  timelineContains,
  timelineFractionAt,
  timelineSpan,
  timelineTimeAt,
  zoomTimelineRangeAt,
  type TimeBounds,
} from '@palsentry/shared';

/**
 * Timeline viewport maths.
 *
 * These live in the server workspace's test runner because the web package has no runner of its
 * own; the code under test is in `@palsentry/shared`, so the assertions are about the same
 * functions the browser uses.
 */

/** A day of retained history, the wayback default. */
const HOUR = 3_600;
const BOUNDS: TimeBounds = { from: 1_000_000, to: 1_000_000 + 24 * HOUR };
const MIN_SPAN = minimumTimelineSpanSeconds(5);

describe('minimumTimelineSpanSeconds', () => {
  it('keeps a readable floor for a fine cadence', () => {
    assert.equal(minimumTimelineSpanSeconds(5), 60);
    assert.equal(minimumTimelineSpanSeconds(15), 60);
  });

  it('shows at least two observations for a coarse cadence', () => {
    assert.equal(minimumTimelineSpanSeconds(60), 120);
    assert.equal(minimumTimelineSpanSeconds(300), 600);
  });

  it('falls back to a minute for unusable input', () => {
    assert.equal(minimumTimelineSpanSeconds(0), 60);
    assert.equal(minimumTimelineSpanSeconds(Number.NaN), 60);
    assert.equal(minimumTimelineSpanSeconds(-30), 60);
  });
});

describe('clampTimelineRange', () => {
  it('leaves a range that already fits alone', () => {
    const range = { from: BOUNDS.from + HOUR, to: BOUNDS.from + 2 * HOUR };
    assert.deepEqual(clampTimelineRange(range, BOUNDS, MIN_SPAN), range);
  });

  it('rounds fractional seconds to whole seconds', () => {
    const clamped = clampTimelineRange(
      { from: BOUNDS.from + 1.6, to: BOUNDS.from + 601.2 },
      BOUNDS,
      MIN_SPAN,
    );
    assert.deepEqual(clamped, { from: BOUNDS.from + 1, to: BOUNDS.from + 601 });
    assert.ok(Number.isInteger(clamped.from) && Number.isInteger(clamped.to));
  });

  it('grows a range narrower than the minimum span from its start', () => {
    const clamped = clampTimelineRange(
      { from: BOUNDS.from + HOUR, to: BOUNDS.from + HOUR + 5 },
      BOUNDS,
      MIN_SPAN,
    );
    assert.equal(timelineSpan(clamped), MIN_SPAN);
    assert.equal(clamped.from, BOUNDS.from + HOUR);
  });

  it('trims a range wider than the bounds to the whole retained window', () => {
    const clamped = clampTimelineRange(
      { from: BOUNDS.from - 5 * 24 * HOUR, to: BOUNDS.from + 2 * HOUR },
      BOUNDS,
      MIN_SPAN,
    );
    assert.deepEqual(clamped, BOUNDS);
  });

  it('slides a range that starts before the retained horizon', () => {
    const clamped = clampTimelineRange(
      { from: BOUNDS.from - HOUR, to: BOUNDS.from + HOUR },
      BOUNDS,
      MIN_SPAN,
    );
    assert.deepEqual(clamped, { from: BOUNDS.from, to: BOUNDS.from + 2 * HOUR });
  });

  it('slides a range that reaches into the future', () => {
    const clamped = clampTimelineRange(
      { from: BOUNDS.to + HOUR, to: BOUNDS.to + 2 * HOUR },
      BOUNDS,
      MIN_SPAN,
    );
    assert.deepEqual(clamped, { from: BOUNDS.to - HOUR, to: BOUNDS.to });
  });

  it('never returns a span the bounds cannot hold', () => {
    const tiny: TimeBounds = { from: 5_000, to: 5_010 };
    const clamped = clampTimelineRange({ from: 0, to: 10_000_000 }, tiny, MIN_SPAN);
    assert.deepEqual(clamped, tiny);
  });

  it('survives reversed, degenerate, and non-finite input', () => {
    for (const range of [
      { from: BOUNDS.from + HOUR, to: BOUNDS.from },
      { from: BOUNDS.from + HOUR, to: BOUNDS.from + HOUR },
      { from: Number.NaN, to: Number.NaN },
      { from: Number.POSITIVE_INFINITY, to: Number.NEGATIVE_INFINITY },
    ]) {
      const clamped = clampTimelineRange(range, BOUNDS, MIN_SPAN);
      assert.ok(Number.isInteger(clamped.from), `from is not an integer for ${String(range)}`);
      assert.ok(Number.isInteger(clamped.to), `to is not an integer for ${String(range)}`);
      assert.ok(clamped.from >= BOUNDS.from && clamped.to <= BOUNDS.to);
      assert.ok(timelineSpan(clamped) >= MIN_SPAN);
    }
  });
});

describe('panTimelineRange', () => {
  it('shifts the window and preserves its span', () => {
    const range = { from: BOUNDS.from + 10 * HOUR, to: BOUNDS.from + 11 * HOUR };
    const panned = panTimelineRange(range, -2 * HOUR, BOUNDS, MIN_SPAN);
    assert.deepEqual(panned, { from: BOUNDS.from + 8 * HOUR, to: BOUNDS.from + 9 * HOUR });
    assert.equal(timelineSpan(panned), timelineSpan(range));
  });

  it('stops at the retained horizon without shrinking', () => {
    const range = { from: BOUNDS.from + HOUR, to: BOUNDS.from + 2 * HOUR };
    const panned = panTimelineRange(range, -10 * HOUR, BOUNDS, MIN_SPAN);
    assert.deepEqual(panned, { from: BOUNDS.from, to: BOUNDS.from + HOUR });
    assert.equal(timelineSpan(panned), HOUR, 'panning is not zooming');
  });

  it('stops at the present without shrinking', () => {
    const range = { from: BOUNDS.to - HOUR, to: BOUNDS.to };
    const panned = panTimelineRange(range, 10 * HOUR, BOUNDS, MIN_SPAN);
    assert.deepEqual(panned, range);
    assert.equal(timelineSpan(panned), HOUR);
  });

  it('rounds a fractional drag to whole seconds and ignores nonsense', () => {
    const range = { from: BOUNDS.from + 10 * HOUR, to: BOUNDS.from + 11 * HOUR };
    assert.deepEqual(
      panTimelineRange(range, -60.4, BOUNDS, MIN_SPAN),
      panTimelineRange(range, -60, BOUNDS, MIN_SPAN),
    );
    assert.deepEqual(panTimelineRange(range, Number.NaN, BOUNDS, MIN_SPAN), range);
  });
});

describe('zoomTimelineRangeAt', () => {
  it('keeps the instant under the pointer stationary', () => {
    const range = { from: BOUNDS.from, to: BOUNDS.from + 4 * HOUR };
    const anchor = 0.25;
    const anchoredAt = range.from + anchor * timelineSpan(range);

    const zoomed = zoomTimelineRangeAt(range, HOUR, anchor, BOUNDS, MIN_SPAN);

    assert.equal(timelineSpan(zoomed), HOUR);
    const anchoredAfter = zoomed.from + anchor * timelineSpan(zoomed);
    assert.ok(
      Math.abs(anchoredAfter - anchoredAt) <= 0.5,
      `anchor drifted by ${Math.abs(anchoredAfter - anchoredAt)}s`,
    );
  });

  it('zooms out around the same anchor', () => {
    const range = { from: BOUNDS.from + 4 * HOUR, to: BOUNDS.from + 5 * HOUR };
    const zoomed = zoomTimelineRangeAt(range, 4 * HOUR, 0.5, BOUNDS, MIN_SPAN);

    assert.equal(timelineSpan(zoomed), 4 * HOUR);
    assert.equal(zoomed.from + 2 * HOUR, range.from + 0.5 * HOUR);
  });

  it('refuses to zoom past the minimum span', () => {
    const range = { from: BOUNDS.from + HOUR, to: BOUNDS.from + HOUR + 600 };
    const zoomed = zoomTimelineRangeAt(range, 1, 0.5, BOUNDS, MIN_SPAN);
    assert.equal(timelineSpan(zoomed), MIN_SPAN);
  });

  it('refuses to zoom past the bounds', () => {
    const range = { from: BOUNDS.from + HOUR, to: BOUNDS.from + 2 * HOUR };
    const zoomed = zoomTimelineRangeAt(range, 10 * 24 * HOUR, 0.5, BOUNDS, MIN_SPAN);
    assert.deepEqual(zoomed, BOUNDS);
  });

  it('clamps an anchor beyond the track instead of escaping the bounds', () => {
    const range = { from: BOUNDS.from + HOUR, to: BOUNDS.from + 2 * HOUR };
    for (const anchor of [-5, 5, Number.NaN]) {
      const zoomed = zoomTimelineRangeAt(range, 30 * 60, anchor, BOUNDS, MIN_SPAN);
      assert.ok(zoomed.from >= BOUNDS.from && zoomed.to <= BOUNDS.to, `anchor ${anchor} escaped`);
      assert.equal(timelineSpan(zoomed), 30 * 60);
    }
  });
});

describe('track mapping', () => {
  const range = { from: 1_000, to: 2_000 };

  it('maps instants to fractions and back', () => {
    assert.equal(timelineFractionAt(range, 1_250), 0.25);
    assert.equal(timelineTimeAt(range, 0.25), 1_250);
    assert.equal(timelineFractionAt(range, 1_000), 0);
    assert.equal(timelineFractionAt(range, 2_000), 1);
  });

  it('reports whether an instant is visible', () => {
    assert.equal(timelineContains(range, 1_000), true);
    assert.equal(timelineContains(range, 2_000), true);
    assert.equal(timelineContains(range, 999), false);
    assert.equal(timelineContains(range, 2_001), false);
    assert.equal(timelineContains(range, Number.NaN), false);
  });

  it('clamps fractions outside the track', () => {
    assert.equal(timelineTimeAt(range, -1), 1_000);
    assert.equal(timelineTimeAt(range, 2), 2_000);
  });
});

describe('nearestTimestamp', () => {
  const values = [100, 200, 300, 400, 500];

  it('snaps to the closest recorded instant', () => {
    assert.equal(nearestTimestamp(values, 190), 200);
    assert.equal(nearestTimestamp(values, 211), 200);
    assert.equal(nearestTimestamp(values, 399), 400);
  });

  it('prefers the earlier instant on a tie', () => {
    assert.equal(nearestTimestamp(values, 250), 200);
  });

  it('clamps beyond either end', () => {
    assert.equal(nearestTimestamp(values, -1_000), 100);
    assert.equal(nearestTimestamp(values, 10_000), 500);
  });

  it('returns null when there is nothing to snap to', () => {
    assert.equal(nearestTimestamp([], 100), null);
  });

  it('handles a single value and a non-finite target', () => {
    assert.equal(nearestTimestamp([42], 900), 42);
    assert.equal(nearestTimestamp(values, Number.NaN), 100);
  });
});
