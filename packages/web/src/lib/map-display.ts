import {
  DEFAULT_MAP_PROJECTION,
  DEFAULT_MAP_TEXTURE_URL,
  DEFAULT_WORLD_TREE_TEXTURE_URL,
  IDENTITY_CALIBRATION,
  MAP_SCENE_SIZE,
  mapLayerForPoint,
  mapSpaceToTexture,
  projectToMapLayer,
  worldToMapSpace,
  type MapCalibration,
  type MapLayerId,
  type MapMeta,
  type MapPoint,
} from '@palsentry/shared';

/**
 * Display plumbing shared by the interactive world map and the dashboard's live previews.
 *
 * Both surfaces have to answer the same three questions — which texture to draw, where a raw
 * world coordinate lands on that texture, and which nudges the operator has saved — so the answers
 * live here rather than in whichever component happened to need them first. Nothing in this module
 * holds state or touches the DOM: camera, gestures, and persistence stay with the components.
 */

/** Map metadata matching the server's defaults, for rendering before `/meta` has answered. */
export const DEFAULT_MAP_META: MapMeta = {
  projection: DEFAULT_MAP_PROJECTION,
  layers: {
    palpagos: { textureUrl: DEFAULT_MAP_TEXTURE_URL },
    worldTree: { textureUrl: DEFAULT_WORLD_TREE_TEXTURE_URL },
  },
};

export function resolveMapMeta(map: MapMeta | null | undefined): MapMeta {
  return map ?? DEFAULT_MAP_META;
}

export type CalibrationByLayer = Record<MapLayerId, MapCalibration>;

/** Where the per-layer nudges are stored. Versioned: the shape changed when World Tree arrived. */
export const CALIBRATION_STORAGE_KEY = 'palsentry:mapCalibration:v2';

/** Pre-World-Tree key, still read so an existing Palpagos nudge is not silently lost. */
const LEGACY_CALIBRATION_STORAGE_KEY = 'palsentry:mapCalibration';

export function normaliseCalibration(value: unknown): MapCalibration {
  const parsed = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Partial<MapCalibration>;
  const scale = Number(parsed.scale);
  return {
    offsetX: Number(parsed.offsetX) || 0,
    offsetY: Number(parsed.offsetY) || 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

/**
 * Read the saved nudges, falling back to identity.
 *
 * Anything unusable in storage degrades to "no nudge" instead of throwing: a corrupt browser value
 * must never stop a map from rendering.
 */
export function readCalibrations(): CalibrationByLayer {
  const defaults: CalibrationByLayer = {
    palpagos: { ...IDENTITY_CALIBRATION },
    worldTree: { ...IDENTITY_CALIBRATION },
  };

  try {
    const stored = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<Record<MapLayerId, unknown>>;
      return {
        palpagos: normaliseCalibration(parsed.palpagos),
        worldTree: normaliseCalibration(parsed.worldTree),
      };
    }

    const legacy = localStorage.getItem(LEGACY_CALIBRATION_STORAGE_KEY);
    if (legacy !== null) defaults.palpagos = normaliseCalibration(JSON.parse(legacy));
  } catch {
    // A corrupt browser value should never stop the map from rendering.
  }

  return defaults;
}

/**
 * Whether a layer is drawn as its texture rather than as a coordinate grid.
 *
 * `failedTextureUrl` records URLs the browser could not load, keyed by layer, so a broken override
 * falls back to the grid instead of leaving an empty frame.
 */
export function textureModeFor(
  layer: MapLayerId,
  map: MapMeta,
  failedTextureUrl: Readonly<Record<MapLayerId, string | null>>,
): boolean {
  const url = map.layers[layer].textureUrl;
  return map.projection !== 'none' && url !== null && url !== '' && failedTextureUrl[layer] !== url;
}

/**
 * Apply the operator's nudge to a normalized (0–1) layer position.
 *
 * Offsets are stored as a percentage of the map, which is also how the calibration controls label
 * them, so the scale factor multiplies the position and the offsets are added afterwards.
 */
export function calibrateScenePoint(
  layer: MapLayerId,
  point: MapPoint,
  calibrations: CalibrationByLayer,
): MapPoint {
  const value = calibrations[layer];
  return {
    x: (point.x * value.scale + value.offsetX / 100) * MAP_SCENE_SIZE,
    y: (point.y * value.scale + value.offsetY / 100) * MAP_SCENE_SIZE,
  };
}

export interface ProjectionContext {
  map: MapMeta;
  calibrations: CalibrationByLayer;
  /** Per-layer texture availability, from {@link textureModeFor}. */
  textureMode: Record<MapLayerId, boolean>;
}

/**
 * Project a raw world position onto one named layer, in scene coordinates.
 *
 * Returns `null` when the point belongs to another region or the projection cannot place it, which
 * is what keeps a World Tree player off the Palpagos map.
 *
 * Palpagos keeps the affine texture projection, because that is the calibration its bundled
 * texture was measured against; every other layer uses the normalized bounds projection.
 */
export function projectWorldToLayer(
  layer: MapLayerId,
  worldX: number,
  worldY: number,
  context: ProjectionContext,
): MapPoint | null {
  if (mapLayerForPoint({ x: worldX, y: worldY }) !== layer) return null;

  if (layer === 'palpagos' && context.textureMode[layer] === true) {
    const mapPoint = worldToMapSpace(worldX, worldY, context.map.projection);
    if (mapPoint === null) return null;
    const percent = mapSpaceToTexture(mapPoint, context.calibrations[layer], 100, 100);
    return {
      x: (percent.x / 100) * MAP_SCENE_SIZE,
      y: (percent.y / 100) * MAP_SCENE_SIZE,
    };
  }

  const normalized = projectToMapLayer({ x: worldX, y: worldY }, layer);
  return normalized === null ? null : calibrateScenePoint(layer, normalized, context.calibrations);
}
