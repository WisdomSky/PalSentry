import type { EnrichedPlayer } from './contract.js';

/**
 * Row ordering for the player roster table.
 *
 * The roster mixes two kinds of row: connected players, which carry live session values, and
 * remembered players, which do not. Sorting that mixture is easy to get subtly wrong — an offline
 * row has no ping to compare, and "most recent first" has to mean something for rows that are
 * online right now — so the ordering lives here as pure functions rather than inline in the Vue
 * component, where the server test workspace can cover it.
 */

/** Columns the roster can be ordered by. */
export type PlayerSortKey = 'name' | 'level' | 'ping' | 'building_count' | 'lastOnline';

export interface PlayerSort {
  key: PlayerSortKey;
  /** `true` sorts ascending. The default recency view is descending. */
  ascending: boolean;
}

/** The order the roster opens in: online players first, then the most recent departure. */
export const DEFAULT_ROSTER_SORT: PlayerSort = { key: 'lastOnline', ascending: false };

/**
 * Session-only counters are absent for offline rows, which belong at the end of either direction.
 *
 * Treating a missing ping as `0` would sort a disconnected player as though they had a perfect
 * connection, so absent values are pushed to the end instead of being given a pretend number.
 */
function compareNullableNumber(
  left: number | null,
  right: number | null,
  direction: number,
): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  return (left - right) * direction;
}

/**
 * Order two roster rows for display.
 *
 * Every comparison reverses with `ascending`, so flipping a column is a genuine reverse of that
 * column's ordering rather than a partial one.
 */
export function comparePlayers(
  left: EnrichedPlayer,
  right: EnrichedPlayer,
  sort: PlayerSort,
): number {
  const direction = sort.ascending ? 1 : -1;

  if (sort.key === 'lastOnline') {
    // Online ranks above offline, and a newer sighting ranks above an older one.
    const onlineRank = Number(left.online) - Number(right.online);
    if (onlineRank !== 0) return onlineRank * direction;

    const recency = left.lastOnline.localeCompare(right.lastOnline);
    // Every player in one snapshot shares a timestamp, so ties are common and are broken by name
    // — always ascending, so the table does not reshuffle between polls.
    return recency !== 0 ? recency * direction : left.name.localeCompare(right.name);
  }

  if (sort.key === 'ping' || sort.key === 'building_count') {
    return compareNullableNumber(left[sort.key], right[sort.key], direction);
  }

  if (sort.key === 'level') return (left.level - right.level) * direction;

  return left.name.localeCompare(right.name) * direction;
}

/** Order a roster without mutating the input, which may be a store-derived array. */
export function sortPlayers(
  players: readonly EnrichedPlayer[],
  sort: PlayerSort,
): EnrichedPlayer[] {
  return [...players].sort((left, right) => comparePlayers(left, right, sort));
}
