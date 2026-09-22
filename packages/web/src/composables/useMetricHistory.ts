import { computed, ref, watch, type Ref } from 'vue';
import type { HistoryResponse, HistorySelection } from '@palsentry/shared';
import { api, errorMessage } from '@/lib/api';
import { usePolling } from './usePolling';

export interface UseMetricHistoryResult {
  /** The last successful response; kept on screen while a newer request is in flight or fails. */
  response: Ref<HistoryResponse | null>;
  /** A human-readable failure message, cleared by the next success. */
  error: Ref<string | null>;
  /** True only for the very first load, so a refresh does not blank the chart. */
  loading: Ref<boolean>;
  /** True while any request is in flight. */
  refreshing: Ref<boolean>;
  /** Load exactly the current selection, outside the poll schedule. */
  reload: () => Promise<void>;
}

/**
 * History for one metric card.
 *
 * Each card owns its request, response, and error state, so re-ranging one chart never disturbs
 * another. Rolling presets poll on the sample cadence; a fixed custom range loads once and then
 * stops, because a completed past range cannot gain new samples.
 *
 * A monotonically increasing request id guards against out-of-order responses: when the operator
 * changes ranges, the in-flight request for the previous range is ignored when it lands.
 */
export function useMetricHistory(
  selection: Ref<HistorySelection>,
  pollIntervalMs: Ref<number>,
): UseMetricHistoryResult {
  const response = ref<HistoryResponse | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(true);
  const inFlight = ref(false);

  let latestRequest = 0;

  async function load(): Promise<void> {
    const request = (latestRequest += 1);
    const requested: HistorySelection = { ...selection.value };
    inFlight.value = true;

    try {
      const next = await api.history(requested);
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

  // Only a rolling preset can gain samples; a fixed range is a one-shot read.
  const intervalMs = computed(() => (selection.value.kind === 'window' ? pollIntervalMs.value : 0));

  // `usePolling` drives the schedule; every run still goes through `load`, so the same guard and
  // error handling apply whether the trigger was the timer or a range change.
  usePolling(load, { intervalMs });

  // Changing the range must not wait for the next poll tick.
  watch(selection, () => void load(), { deep: true });

  return { response, error, loading, refreshing: inFlight, reload: load };
}
