import type { Ref } from 'vue';
import type { HistoryResponse, HistorySelection } from '@palsentry/shared';
import { api } from '@/lib/api';
import { useHistoryResource, type UseHistoryResourceResult } from './useHistoryResource';

export type UseMetricHistoryResult = UseHistoryResourceResult<HistoryResponse>;

/**
 * History for one metric card.
 *
 * Each card owns its request, response, and error state, so re-ranging one chart never disturbs
 * another. Rolling presets poll on the sample cadence; a fixed custom range loads once and then
 * stops, because a completed past range cannot gain new samples.
 *
 * `includePlayers` is a per-card decision: the server looks up recorded names once per bucket for
 * a chart that shows them, and the other charts should not pay for that on every poll.
 */
export function useMetricHistory(
  selection: Ref<HistorySelection>,
  pollIntervalMs: Ref<number>,
  options: { includePlayers?: boolean } = {},
): UseMetricHistoryResult {
  const includePlayers = options.includePlayers === true;

  return useHistoryResource(
    (requested) => api.history(requested, { includePlayers }),
    selection,
    pollIntervalMs,
  );
}
