interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/**
 * Coalesces concurrent identical upstream calls and caches results for a short window.
 *
 * This exists so that N open dashboards polling every few seconds produce **one** request to
 * the Palworld server rather than N. Without it, the app would add load to the very server it
 * is meant to be monitoring, and the game server's REST API is not built for fan-in.
 *
 * Failures are never cached: a server that is down should be retried on the next poll so
 * recovery is noticed immediately.
 */
export class SingleFlightCache {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Return a cached value, join an in-flight request, or start a new one.
   *
   * @param ttlMs Cache lifetime. `0` disables caching for this call (still single-flighted).
   */
  async run<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const cached = this.entries.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        return cached.value as T;
      }
    }

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const promise = (async (): Promise<T> => {
      try {
        const value = await fn();
        if (ttlMs > 0) {
          this.entries.set(key, { expiresAt: Date.now() + ttlMs, value });
        }
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop cached values, optionally only those whose key starts with `prefix`. */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Number of cached entries — used by tests. */
  get size(): number {
    return this.entries.size;
  }
}
