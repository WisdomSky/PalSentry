import { computed, ref, watch, type Ref } from 'vue';
import type { HistorySelection } from '@palsentry/shared';
import { errorMessage } from '@/lib/api';
import { usePolling } from './usePolling';

export interface UseHistoryResourceResult<T> {
  /** The last successful response; kept on screen while a newer request is in flight or fails. */
  response: Ref<T | null>;
  /** A human-readable failure message, cleared by the next success. */
  error: Ref<string | null>;
  /** True only for the very first load, so a refresh does not blank the view. */
  loading: Ref<boolean>;
  /** True while any request is in flight. */
  refreshing: Ref<boolean>;
  /** Load exactly the current selection, outside the poll schedule. */
  reload: () => Promise<void>;
}

/**
 * One retention-bounded history range, loaded and kept current.
 *
 * Shared by the metric charts and the wayback map because the shape of the problem is identical:
 * a rolling preset gains samples and must be polled, a fixed past range cannot and is read once,
 * and a slow answer for a range the operator has already moved away from must be discarded rather
 * than drawn. What differs is only which endpoint answers, so the caller passes the fetcher.
 *
 * A monotonically increasing request id guards against out-of-order responses: when the operator
 * changes ranges, the in-flight request for the previous range is ignored when it lands.
 */
export function useHistoryResource<T>(
  fetchHistory: (selection: HistorySelection) => Promise<T>,
  selection: Ref<HistorySelection>,
  pollIntervalMs: Ref<number>,
  options: {
    /**
     * When false, nothing is requested at all. Defaults to always enabled.
     *
     * A view that only sometimes needs history — the map needs it in wayback mode and not on the
     * live view — would otherwise pay for a full range query on every visit just in case.
     */
    enabled?: Ref<boolean>;
  } = {},
): UseHistoryResourceResult<T> {
  const response = ref<T | null>(null) as Ref<T | null>;
  const error = ref<string | null>(null);
  const loading = ref(true);
  const inFlight = ref(false);

  const enabled = computed(() => options.enabled?.value ?? true);

  let latestRequest = 0;

  async function load(): Promise<void> {
    if (!enabled.value) return;

    const request = (latestRequest += 1);
    const requested: HistorySelection = { ...selection.value };
    inFlight.value = true;

    try {
      const next = await fetchHistory(requested);
      // A newer selection has already been issued; this answer is stale.
      if (request !== latestRequest) return;
      response.value = next;
      error.value = null;
    } catch (cause) {
      if (request !== latestRequest) return;
      error.value = errorMessage(cause);
    } finally {
      if (request === latestRequest) {
        loading.value = false;
        inFlight.value = false;
      }
    }
  }

  // Only a rolling preset can gain samples; a fixed range is a one-shot read. A disabled resource
  // polls at zero, which is how `usePolling` is told to stop its timer entirely.
  const intervalMs = computed(() =>
    !enabled.value || selection.value.kind !== 'window' ? 0 : pollIntervalMs.value,
  );

  // `usePolling` drives the schedule; every run still goes through `load`, so the same guard and
  // error handling apply whether the trigger was the timer or a range change.
  usePolling(load, { intervalMs });

  // Changing the range must not wait for the next poll tick.
  watch(selection, () => void load(), { deep: true });

  // Enabling after the fact has to load: the mount-time run was skipped, and showing the empty
  // state until the next tick would look like "no history" rather than "not asked yet".
  watch(enabled, (on) => {
    if (!on) return;
    loading.value = true;
    void load();
  });

  return { response, error, loading, refreshing: inFlight, reload: load };
}
