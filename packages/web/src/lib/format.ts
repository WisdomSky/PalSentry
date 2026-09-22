/** Formatting helpers shared across views. */

/** Compact uptime, e.g. `3d 4h`, `4h 12m`, `12m 30s`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** A duration in milliseconds, for the restart card. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return formatUptime(ms / 1000);
}

/** `2026-09-20T20:54:41.537Z` → `20:54:41`. */
export function formatTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/** Full local timestamp for audit rows. */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Relative time, e.g. `4m ago`. */
export function formatRelative(iso: string | null, now = Date.now()): string {
  if (iso === null) return '—';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '—';

  const deltaSeconds = Math.round((now - timestamp) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const suffix = deltaSeconds >= 0 ? 'ago' : 'from now';

  if (absolute < 60) return `${absolute}s ${suffix}`;
  if (absolute < 3_600) return `${Math.round(absolute / 60)}m ${suffix}`;
  if (absolute < 86_400) return `${Math.round(absolute / 3_600)}h ${suffix}`;
  return `${Math.round(absolute / 86_400)}d ${suffix}`;
}

/** Timeline label for a history chart: clock time, plus the date once a span exceeds a day. */
export function formatChartTime(unixSeconds: number, spanSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const longSpan = Number.isFinite(spanSeconds) && spanSeconds > 86_400;
  return date.toLocaleString(undefined, {
    ...(longSpan ? { month: 'short', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Full local timestamp for a single history sample.
 *
 * Chart tooltips name one exact bucket, so unlike the axis labels this always carries the date and
 * the weekday — at which point the year is the only part that would be noise.
 */
export function formatChartTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Absolute Unix seconds → a `<input type="datetime-local">` value.
 *
 * The conversion goes through the browser's `Date`, so the operator's own timezone and any DST
 * boundary are handled locally. The server only ever sees whole Unix seconds.
 */
export function unixSecondsToLocalInput(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * A `<input type="datetime-local">` value → absolute Unix seconds, or `null` when unusable.
 *
 * Values the `Date` constructor would silently roll over (say `2026-02-30`) are rejected instead
 * of being quietly turned into a different day.
 */
export function localInputToUnixSeconds(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null) return null;

  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = second === undefined ? 0 : Number(second);

  const date = new Date(y, mo - 1, d, h, mi, s, 0);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  // Rollover guard: a normalised date means the input named a day that does not exist.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;

  return Math.floor(time / 1000);
}

/** A short, unambiguous label for a resolved history range, for chart captions. */
export function formatHistoryRange(from: number, to: number): string {
  const span = to - from;
  const showDate = span > 86_400;
  const format = (seconds: number): string => {
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      ...(showDate ? { month: 'short', day: '2-digit' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };
  return `${format(from)} – ${format(to)}`;
}

/** Colour a ping value: green under 60ms, amber under 150ms, red above. */
export function pingTone(ping: number): string {
  if (ping < 60) return 'text-emerald-600 dark:text-emerald-400';
  if (ping < 150) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

/** Colour FPS: 55+ is healthy for Palworld, below 30 is visibly janky. */
export function fpsTone(fps: number): string {
  if (fps >= 55) return 'text-emerald-600 dark:text-emerald-400';
  if (fps >= 30) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

/** Percentage of the player cap in use. */
export function playerLoadPercent(current: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.round((current / max) * 100));
}

/** Truncate a long opaque id for display, keeping both ends recognisable. */
export function truncateId(value: string, max = 20): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
