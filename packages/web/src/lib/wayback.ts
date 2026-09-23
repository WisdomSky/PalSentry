import type { WaybackPlayerHistory } from '@palsentry/shared';

/**
 * Turning recorded positions into something the map can draw.
 *
 * The server answers with raw world coordinates; deciding which of them belong on the map at one
 * instant is a *drawing* decision, so it is made here, once, rather than inside the map component
 * while it renders.
 */

/** A world position, ready to be projected onto a map layer. */
export interface WorldPosition {
  x: number;
  y: number;
}

/** One player as the historical map sees them, at one instant. */
export interface WaybackMarker {
  userId: string;
  name: string;
  /** The position recorded at the shown instant. */
  position: WorldPosition;
  /** Stable per-account colour, so a dot can be followed across a whole replay. */
  colour: string;
}

/**
 * Distinguishable hues for player dots.
 *
 * Fixed rather than generated: two accounts that happen to hash nearby must still be tellable
 * apart, and the palette is small enough that a glance memorises it.
 */
const PLAYER_PALETTE: readonly string[] = [
  '#0ea5e9',
  '#8b5cf6',
  '#f97316',
  '#10b981',
  '#ec4899',
  '#eab308',
  '#06b6d4',
  '#a855f7',
  '#84cc16',
  '#f43f5e',
  '#6366f1',
  '#14b8a6',
];

/** A colour for an account, stable across reloads since it depends only on the id. */
export function playerColour(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  }
  return PLAYER_PALETTE[Math.abs(hash) % PLAYER_PALETTE.length] ?? PLAYER_PALETTE[0]!;
}

/**
 * The players recorded at one instant, and where they were.
 *
 * Only accounts present in that exact observation are returned. PalSentry knows where a player was
 * when it observed them and nowhere else, so drawing the last known position of somebody who has
 * since logged off would fill the replay with ghosts who were not there — the map would answer
 * "who has ever been seen?" instead of "who was online then?".
 *
 * Snapshots and per-player points are downsampled with the same buckets and the same anchor, so an
 * equal timestamp means the player was in that observation rather than merely near it.
 */
export function waybackMarkersAt(
  players: readonly WaybackPlayerHistory[],
  ts: number | null,
): WaybackMarker[] {
  if (ts === null) return [];

  const markers: WaybackMarker[] = [];
  for (const player of players) {
    const point = player.points.find((candidate) => candidate.ts === ts);
    if (point === undefined) continue;

    markers.push({
      userId: player.userId,
      name: player.name,
      position: { x: point.x, y: point.y },
      colour: playerColour(player.userId),
    });
  }

  return markers;
}
