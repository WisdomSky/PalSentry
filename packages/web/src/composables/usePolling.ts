import { isRef, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

export interface UsePollingOptions {
  /** Milliseconds between runs. `0` disables automatic polling. May be reactive. */
  intervalMs: Ref<number> | number;
  /** Run once immediately on mount. Defaults to true. */
  immediate?: boolean;
}

export interface UsePollingResult {
  refreshing: Ref<boolean>;
  lastRunAt: Ref<number | null>;
  error: Ref<unknown>;
  /** Run the task now, outside the schedule. */
  run: () => Promise<void>;
}

/**
 * Run an async task on an interval while the component is mounted.
 *
 * For one-off views (bans, audit, settings) rather than the live dashboard, which is driven by
 * the server store's single loop. Pauses while the tab is hidden and catches up on return, so
 * background tabs do not generate traffic.
 *
 * Overlapping runs are prevented: a slow request will not stack up behind the interval.
 *
 * A ref-backed `intervalMs` is watched, so a caller can switch between a rolling cadence and `0`
 * (fixed, load-once data) without tearing down the composable.
 */
export function usePolling(
  task: () => Promise<void>,
  options: UsePollingOptions,
): UsePollingResult {
  const refreshing = ref(false);
  const lastRunAt = ref<number | null>(null);
  const error = ref<unknown>(null);

  let timer: number | null = null;
  let running = false;
  let disposed = false;

  async function run(): Promise<void> {
    if (running || disposed) return;
    running = true;
    refreshing.value = true;

    try {
      await task();
      error.value = null;
    } catch (cause) {
      error.value = cause;
    } finally {
      running = false;
      refreshing.value = false;
      lastRunAt.value = Date.now();
    }
  }

  function stop(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function start(): void {
    stop();
    if (disposed) return;
    const interval =
      typeof options.intervalMs === 'number' ? options.intervalMs : options.intervalMs.value;
    if (interval <= 0) return;

    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, interval);
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') void run();
  }

  onMounted(async () => {
    if (options.immediate !== false) await run();
    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
  });

  // A reactive cadence (preset vs. fixed range, or a changed sample interval) takes effect
  // immediately: `0` stops the timer rather than leaving the old one running.
  if (isRef(options.intervalMs)) {
    watch(options.intervalMs, () => start());
  }

  onBeforeUnmount(() => {
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return { refreshing, lastRunAt, error, run };
}
