import type { Ref } from 'vue';
import type { HistorySelection, PlayerHistoryResponse } from '@palsentry/shared';
import { api } from '@/lib/api';
import { useHistoryResource, type UseHistoryResourceResult } from './useHistoryResource';

export type UsePlayerHistoryResult = UseHistoryResourceResult<PlayerHistoryResponse>;

/**
 * Recorded player movement for the wayback map.
 *
 * The whole selected range arrives in one response — snapshots and a downsampled trail per player
 * — so scrubbing the timeline afterwards is purely client-side. Moving a pointer across a map must
 * never become a stream of requests to the PalSentry server, let alone to the game server.
 */
export function usePlayerHistory(
  selection: Ref<HistorySelection>,
  /** The server's recording cadence: polling faster would only re-read the same snapshots. */
  pollIntervalMs: Ref<number>,
  /** False on the live map, where recorded movement is not being shown at all. */
  enabled: Ref<boolean>,
): UsePlayerHistoryResult {
  return useHistoryResource(api.playerHistory, selection, pollIntervalMs, { enabled });
}
