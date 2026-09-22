import {
  mapLayerForPoint,
  type MapLayerId,
  type WaybackPlayerHistory,
  type WaybackPoint,
} from '@palsentry/shared';

/**
 * Turning recorded positions into something the map can draw.
 *
 * The server answers with raw world coordinates; a trail is a *drawing* decision — where a line is
 * allowed to exist at all — so it is made here, once, rather than inside the map component while
 * it renders.
 */

/** A world position, ready to be projected onto a map layer. */
export interface TrailPoint {
  x: number;
  y: number;
}

/**
 * A run of consecutive observations that can safely be joined by a line.
 *
 * A trail is a set of segments rather than one path because anything else would draw movement that
 * never happened: a player who logged off, teleported, or crossed into the other region was not
 * walking between those two points.
 */
export interface WaybackTrailSegment {
  /** The region every point in the segment belongs to. */
  layer: MapLayerId;
  points: TrailPoint[];
}

/** One player as the historical map sees them, at one instant. */
export interface WaybackPlayerScene {
  userId: string;
  name: string;
  /** True when this account appears in the observation at the effective instant. */
  online: boolean;
  /** Latest recorded position at or before the effective instant, when there is one. */
  position: TrailPoint | null;
  /** Epoch seconds of {@link position}. */
  lastSeenTs: number | null;
  /** Movement up to the effective instant, split wherever the record is not contiguous. */
  trail: WaybackTrailSegment[];
  /**
   * True when the only thing known about this player is a sighting before the range began.
   *
   * They were somewhere, but nothing was recorded inside the window being viewed, which is worth
   * distinguishing from a player who moved within it.
   */
  fromBaseline: boolean;
  /** Stable per-account colour, so a trail can be followed across a whole replay. */
  colour: string;
}

/**
 * Distinguishable hues for player trails.
 *
 * Fixed rather than generated: two accounts that happen to hash nearby must still be tellable
 * apart, and the palette is small enough that a glance memorises it.
 */
const TRAIL_PALETTE: readonly string[] = [
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
export function trailColour(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  }
  return TRAIL_PALETTE[Math.abs(hash) % TRAIL_PALETTE.length] ?? TRAIL_PALETTE[0]!;
}

/**
 * How long a break in the record has to be before a trail is cut.
 *
 * Two buckets, not one: downsampling keeps the last observation in each bucket, so consecutive
 * buckets are normally about one bucket apart, while a genuinely missed observation leaves two.
 */
function gapThresholdSeconds(bucketSeconds: number): number {
  return Math.max(2, bucketSeconds * 2);
}

/**
 * Build the drawable scene for one instant.
 *
 * Returns an empty scene when there is no instant to show, which is the honest answer for a range
 * with no successful observations in it.
 */
export function buildWaybackScene(
  players: readonly WaybackPlayerHistory[],
  effectiveTs: number | null,
  bucketSeconds: number,
): WaybackPlayerScene[] {
  if (effectiveTs === null) return [];

  const gap = gapThresholdSeconds(bucketSeconds);
  const scene: WaybackPlayerScene[] = [];

  for (const player of players) {
    // The baseline belongs to the trail: it is where the player was when the range opened, so it
    // is also the anchor a player who never moved inside the range is shown at.
    const observed: WaybackPoint[] = [];
    if (player.baseline !== null && player.baseline.ts <= effectiveTs) {
      observed.push(player.baseline);
    }
    for (const point of player.points) {
      if (point.ts <= effectiveTs) observed.push(point);
    }

    // Nothing was recorded for this account at or before the shown instant. It has no position to
    // draw and no sighting to report, so it is not part of this moment at all — listing it would
    // add a row of dashes that says only "not yet".
    if (observed.length === 0) continue;

    const trail: WaybackTrailSegment[] = [];
    let current: WaybackTrailSegment | null = null;
    let previousTs: number | null = null;
    let previousLayer: MapLayerId | null = null;

    for (const point of observed) {
      const layer = mapLayerForPoint(point);
      if (layer === null) {
        // A position outside every known region cannot be projected, and whatever comes next is
        // not continuous with what came before it.
        current = null;
        previousTs = null;
        previousLayer = null;
        continue;
      }

      const continuous =
        current !== null &&
        previousTs !== null &&
        previousLayer === layer &&
        point.ts - previousTs <= gap;

      if (!continuous) {
        current = { layer, points: [] };
        trail.push(current);
      }

      current!.points.push({ x: point.x, y: point.y });
      previousTs = point.ts;
      previousLayer = layer;
    }

    const latest = observed.at(-1) ?? null;
    const online = player.points.some((point) => point.ts === effectiveTs);

    scene.push({
      userId: player.userId,
      name: player.name,
      online,
      position: latest === null ? null : { x: latest.x, y: latest.y },
      lastSeenTs: latest?.ts ?? null,
      trail,
      fromBaseline: player.points.length === 0 && player.baseline !== null,
      colour: trailColour(player.userId),
    });
  }

  return scene;
}
