/**
 * Value-axis maths for the history charts.
 *
 * The Metrics tab plots sampled series that land on arbitrary numbers — an averaged FPS of 57.3,
 * a frame time of 16.9 ms. Drawing gridlines at `min + n × (max - min) / 4` produces labels nobody
 * can read, so this module snaps the domain outwards to whole steps of a "nice" size instead.
 *
 * The maths is pure and lives here rather than in the Vue component so the server test workspace
 * can cover it without a DOM, exactly like the map projection helpers.
 */

export interface ChartAxisTick {
  /** Value the gridline sits at. */
  value: number;
  /** Pre-formatted label, already rounded to the axis precision. */
  label: string;
}

export interface ChartAxis {
  /** Bottom of the axis, always a whole step and never below zero for non-negative data. */
  min: number;
  /** Top of the axis, always a whole step. */
  max: number;
  /** Distance between adjacent gridlines. */
  step: number;
  /** Decimals used by every label on this axis, so the column lines up. */
  decimals: number;
  ticks: ChartAxisTick[];
}

export interface ChartAxisOptions {
  /** Roughly how many gridlines to aim for. */
  targetTicks?: number;
  /**
   * Preferred label precision. `0` keeps both the steps and the labels on whole numbers, which is
   * what counts want; `1` allows halves and tenths for durations. Left unset, the data decides.
   */
  decimals?: number;
}

const DEFAULT_TARGET_TICKS = 4;

/**
 * Round a raw gridline interval up to the next 1/2/2.5/5 × 10ⁿ value.
 *
 * These are the intervals people read without effort. `wholeOnly` drops the 2.5 tier and floors
 * the input at 1, so a count axis can never end up stepping by half a player.
 */
export function niceStep(raw: number, wholeOnly = false): number {
  const target = wholeOnly ? Math.max(1, raw) : raw;
  if (!Number.isFinite(target) || target <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalised = target / magnitude;

  if (normalised <= 1) return magnitude;
  if (normalised <= 2) return 2 * magnitude;
  if (!wholeOnly && normalised <= 2.5) return 2.5 * magnitude;
  if (normalised <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

/** How many decimal places `step` needs to be written exactly, so labels stay short. */
export function stepDecimals(step: number): number {
  const text = step.toFixed(6).replace(/0+$/, '');
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Build a value axis whose gridlines land on round numbers containing every sample.
 *
 * Returns `null` for an empty series: there is nothing to scale.
 */
export function buildValueAxis(
  values: readonly number[],
  options: ChartAxisOptions = {},
): ChartAxis | null {
  if (values.length === 0) return null;

  const targetTicks = Math.max(1, options.targetTicks ?? DEFAULT_TARGET_TICKS);
  const preferredDecimals = options.decimals;

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  // Counts and rates read badly as fractional gridlines, so a `decimals: 0` axis — or one whose
  // samples all happen to be whole numbers — is stepped in whole units only.
  const wholeOnly =
    preferredDecimals === 0 || (preferredDecimals === undefined && values.every(Number.isInteger));

  // A flat series (or a single sample) has no spread to scale, so invent one around its value.
  const flat = dataMax - dataMin < 1e-9;
  const padding = flat ? (wholeOnly ? 1 : Math.max(0.5, Math.abs(dataMax) * 0.1)) : 0;
  const step = niceStep((flat ? padding * 2 : dataMax - dataMin) / targetTicks, wholeOnly);

  let min = Math.floor((dataMin - padding) / step) * step;
  let max = Math.ceil((dataMax + padding) / step) * step;

  if (!flat) {
    // Snapping alone can leave the highest or lowest sample sitting on the frame, where the axis
    // line hides it; give the axis a step of headroom when that happens.
    if (max - dataMax < step * 0.05) max += step;
    if (dataMin - min < step * 0.05) min -= step;
  }

  // Counts and rates never go negative, so do not invent a gridline below zero for them.
  if (dataMin >= 0) min = Math.max(0, min);

  const decimals = Math.max(stepDecimals(step), preferredDecimals ?? 0);
  const count = Math.max(1, Math.round((max - min) / step));

  return {
    min,
    max,
    step,
    decimals,
    ticks: Array.from({ length: count + 1 }, (_, index) => {
      const value = min + index * step;
      return { value, label: value.toFixed(decimals) };
    }),
  };
}
