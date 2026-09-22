/**
 * Coordinate maths for the live player map.
 *
 * The Palworld REST API hands back raw Unreal world units (a real sample is
 * `location_x = -359583`, `location_y = 267748.59`). There is **no official projection** onto
 * the in-game map, so this module serves two purposes:
 *
 * Palpagos keeps the community reverse-engineered affine projection used by the original map.
 * World Tree is a separate in-game surface, so both regions also have explicit world bounds for
 * classification and normalized scene projection. Camera helpers are pure so browser gestures can
 * be tested in the server workspace without a DOM.
 *
 * Projection constants come from the MIT-licensed PalworldSaveTools project. Layer bounds and axis
 * orientation are based on the MIT-licensed palworld-live-map implementation.
 */

export type MapProjection = 'none' | 'new' | 'legacy';
export type MapLayerId = 'palpagos' | 'worldTree';

export interface MapPoint {
  x: number;
  y: number;
}

/**
 * Affine constants per map generation.
 *
 * Applied exactly as in the upstream Python, note the asymmetric signs:
 * `newX = worldX + tx`, `newY = worldY - ty`, then the axes are swapped on output.
 */
export const MAP_PROJECTION_CONSTANTS = {
  new: { tx: 375247, ty: -18, scale: 725 },
  legacy: { tx: 123888, ty: 158000, scale: 459 },
} as const satisfies Record<'new' | 'legacy', { tx: number; ty: number; scale: number }>;

/** Half-extent of the projected map space. Palpagos lands in roughly `[-1000, 1000]`. */
export const MAP_SPACE_HALF_EXTENT = 1000;

/** Bundled 8192×8192 map textures served by the SPA. */
export const DEFAULT_MAP_TEXTURE_URL = '/maps/T_WorldMap.webp';
export const DEFAULT_WORLD_TREE_TEXTURE_URL = '/maps/T_TreeMap.webp';

/**
 * Projection paired with {@link DEFAULT_MAP_TEXTURE_URL}.
 *
 * `new` is the community Palworld 1.0+ calibration, so pins land correctly against the default
 * texture without any configuration. Operators on older worlds can select `legacy`.
 */
export const DEFAULT_MAP_PROJECTION: MapProjection = 'new';

/** User-tunable nudges for when pins drift after a game update (texture mode only). */
export interface MapCalibration {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export const IDENTITY_CALIBRATION: MapCalibration = { offsetX: 0, offsetY: 0, scale: 1 };

/**
 * Convert world coordinates into projected map space (roughly ±1000 for Palpagos).
 *
 * Returns `null` for the `none` projection so callers fall back to the grid plot instead of
 * silently drawing pins in the wrong place.
 */
export function worldToMapSpace(
  worldX: number,
  worldY: number,
  projection: MapProjection,
): MapPoint | null {
  if (projection === 'none') return null;
  const { tx, ty, scale } = MAP_PROJECTION_CONSTANTS[projection];
  const newX = worldX + tx;
  const newY = worldY - ty;
  // Axes are swapped: projected X follows world Y, projected Y follows world X.
  return { x: newY / scale, y: newX / scale };
}

/** Inverse of {@link worldToMapSpace}. Used by round-trip tests and the calibration panel. */
export function mapSpaceToWorld(
  mapX: number,
  mapY: number,
  projection: MapProjection,
): MapPoint | null {
  if (projection === 'none') return null;
  const { tx, ty, scale } = MAP_PROJECTION_CONSTANTS[projection];
  const newX = mapY * scale;
  const newY = mapX * scale;
  return { x: newX - tx, y: newY + ty };
}

/**
 * Project map space onto texture pixels.
 *
 * Applies the vertical flip (map space grows upward, textures do not) and then the user's
 * calibration nudges, which are expressed in texture pixels.
 */
export function mapSpaceToTexture(
  point: MapPoint,
  calibration: MapCalibration,
  width: number,
  height: number,
): MapPoint {
  const normalisedX = (point.x + MAP_SPACE_HALF_EXTENT) / (MAP_SPACE_HALF_EXTENT * 2);
  const normalisedY = (MAP_SPACE_HALF_EXTENT - point.y) / (MAP_SPACE_HALF_EXTENT * 2);
  const scale = calibration.scale;
  return {
    x: normalisedX * width * scale + calibration.offsetX,
    y: normalisedY * height * scale + calibration.offsetY,
  };
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Native texture bounds in raw Unreal world coordinates. */
export const PALPAGOS_BOUNDS: Bounds = {
  minX: -1_099_400,
  maxX: 349_400,
  minY: -724_400,
  maxY: 724_400,
};

export const WORLD_TREE_BOUNDS: Bounds = {
  minX: 347_351.5,
  maxX: 689_148.5,
  minY: -818_197,
  maxY: -476_400,
};

export interface MapLayerDefinition {
  id: MapLayerId;
  label: string;
  bounds: Bounds;
  defaultTextureUrl: string;
}

export const MAP_LAYERS: readonly MapLayerDefinition[] = [
  {
    id: 'palpagos',
    label: 'Palpagos',
    bounds: PALPAGOS_BOUNDS,
    defaultTextureUrl: DEFAULT_MAP_TEXTURE_URL,
  },
  {
    id: 'worldTree',
    label: 'World Tree',
    bounds: WORLD_TREE_BOUNDS,
    defaultTextureUrl: DEFAULT_WORLD_TREE_TEXTURE_URL,
  },
];

const MAP_LAYER_BY_ID: Readonly<Record<MapLayerId, MapLayerDefinition>> = {
  palpagos: MAP_LAYERS[0]!,
  worldTree: MAP_LAYERS[1]!,
};

export function mapLayerById(id: MapLayerId): MapLayerDefinition {
  return MAP_LAYER_BY_ID[id];
}

export function pointInBounds(point: MapPoint, bounds: Bounds): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

/** Classify World Tree first because its southwest edge narrowly overlaps Palpagos. */
export function mapLayerForPoint(point: MapPoint): MapLayerId | null {
  if (pointInBounds(point, WORLD_TREE_BOUNDS)) return 'worldTree';
  if (pointInBounds(point, PALPAGOS_BOUNDS)) return 'palpagos';
  return null;
}

/**
 * Project raw world coordinates into normalized texture space.
 *
 * Palworld swaps the Unreal axes on its maps: world Y runs left-to-right, while decreasing world
 * X runs top-to-bottom. A result of `{x: 0, y: 0}` is the texture's top-left corner.
 */
export function projectToMapLayer(point: MapPoint, layer: MapLayerId): MapPoint | null {
  const bounds = mapLayerById(layer).bounds;
  if (!pointInBounds(point, bounds)) return null;
  return {
    x: (point.y - bounds.minY) / (bounds.maxY - bounds.minY),
    y: (bounds.maxX - point.x) / (bounds.maxX - bounds.minX),
  };
}

/** Fallback viewport retained for the legacy auto-fit grid helpers. */
export const DEFAULT_BOUNDS: Bounds = { ...PALPAGOS_BOUNDS };

/**
 * Auto-fit a viewport to the online players.
 *
 * `paddingRatio` keeps markers away from the edges. `minSpan` guarantees a usable viewport when
 * everyone is standing on top of each other (or only one player is online) — without it, a
 * single player would produce a zero-width box and the grid would divide by zero.
 */
export function boundsOf(
  points: readonly MapPoint[],
  paddingRatio = 0.15,
  minSpan = 20_000,
): Bounds {
  if (points.length === 0) return { ...DEFAULT_BOUNDS };

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (Number.isFinite(point.x)) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
    }
    if (Number.isFinite(point.y)) {
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }

  // Every point was non-finite — fall back rather than returning an inverted box.
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { ...DEFAULT_BOUNDS };

  // Guarantee a minimum span, centred on the data, so degenerate cases stay renderable.
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (spanX < minSpan) {
    const centre = (minX + maxX) / 2;
    minX = centre - minSpan / 2;
    maxX = centre + minSpan / 2;
  }
  if (spanY < minSpan) {
    const centre = (minY + maxY) / 2;
    minY = centre - minSpan / 2;
    maxY = centre + minSpan / 2;
  }

  const padX = (maxX - minX) * paddingRatio;
  const padY = (maxY - minY) * paddingRatio;

  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

/**
 * Map a world point into normalised `[0, 1]` viewport space.
 *
 * Y is inverted so that larger world Y appears higher on screen, matching how the in-game map
 * reads.
 */
export function projectToViewport(point: MapPoint, bounds: Bounds): MapPoint {
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  return {
    x: (point.x - bounds.minX) / spanX,
    y: (bounds.maxY - point.y) / spanY,
  };
}

/**
 * Smoothly interpolate between two viewports so pins do not jump when the auto-fit refits on
 * each poll. `t` of 0 returns `from`, 1 returns `to`.
 */
export function lerpBounds(from: Bounds, to: Bounds, t: number): Bounds {
  const clamped = Math.min(1, Math.max(0, t));
  const mix = (a: number, b: number) => a + (b - a) * clamped;
  return {
    minX: mix(from.minX, to.minX),
    maxX: mix(from.maxX, to.maxX),
    minY: mix(from.minY, to.minY),
    maxY: mix(from.maxY, to.maxY),
  };
}

export interface MapCamera {
  /** Screen-space translation from the viewport's top-left corner. */
  x: number;
  y: number;
  /** Screen pixels per scene unit. */
  scale: number;
}

export const MAP_SCENE_SIZE = 1_000;
export const MAP_MAX_ZOOM_RATIO = 20;

/** Fit the complete square map into the viewport and centre any letterboxing. */
export function fitMapCamera(
  viewportWidth: number,
  viewportHeight: number,
  sceneSize = MAP_SCENE_SIZE,
): MapCamera {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : sceneSize;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : sceneSize;
  const size = Number.isFinite(sceneSize) && sceneSize > 0 ? sceneSize : MAP_SCENE_SIZE;
  const scale = Math.min(width / size, height / size);
  return {
    scale,
    x: (width - size * scale) / 2,
    y: (height - size * scale) / 2,
  };
}

/** Keep zoom within limits and prevent the map from being panned completely out of view. */
export function clampMapCamera(
  camera: MapCamera,
  viewportWidth: number,
  viewportHeight: number,
  sceneSize = MAP_SCENE_SIZE,
  maxZoomRatio = MAP_MAX_ZOOM_RATIO,
): MapCamera {
  const fit = fitMapCamera(viewportWidth, viewportHeight, sceneSize);
  const safeRatio = Number.isFinite(maxZoomRatio) && maxZoomRatio >= 1 ? maxZoomRatio : 1;
  const requestedScale = Number.isFinite(camera.scale) ? camera.scale : fit.scale;
  const scale = Math.min(fit.scale * safeRatio, Math.max(fit.scale, requestedScale));
  const scaledSize = sceneSize * scale;

  const clampAxis = (value: number, viewport: number): number => {
    if (scaledSize <= viewport) return (viewport - scaledSize) / 2;
    const finite = Number.isFinite(value) ? value : 0;
    return Math.min(0, Math.max(viewport - scaledSize, finite));
  };

  return {
    scale,
    x: clampAxis(camera.x, viewportWidth),
    y: clampAxis(camera.y, viewportHeight),
  };
}

export function panMapCamera(
  camera: MapCamera,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
  sceneSize = MAP_SCENE_SIZE,
  maxZoomRatio = MAP_MAX_ZOOM_RATIO,
): MapCamera {
  return clampMapCamera(
    {
      ...camera,
      x: camera.x + (Number.isFinite(deltaX) ? deltaX : 0),
      y: camera.y + (Number.isFinite(deltaY) ? deltaY : 0),
    },
    viewportWidth,
    viewportHeight,
    sceneSize,
    maxZoomRatio,
  );
}

/**
 * Focus a scene point as close to the viewport centre as the bounded camera permits.
 *
 * `minimumZoomRatio` is relative to the fitted scale. Existing closer zoom is preserved, which
 * lets a following camera recenter a moving marker without fighting the operator's zoom choice.
 */
export function focusMapCamera(
  camera: MapCamera,
  point: MapPoint,
  viewportWidth: number,
  viewportHeight: number,
  minimumZoomRatio = 1,
  sceneSize = MAP_SCENE_SIZE,
  maxZoomRatio = MAP_MAX_ZOOM_RATIO,
): MapCamera {
  const current = clampMapCamera(camera, viewportWidth, viewportHeight, sceneSize, maxZoomRatio);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return current;

  const fit = fitMapCamera(viewportWidth, viewportHeight, sceneSize);
  const safeMaximum = Number.isFinite(maxZoomRatio) && maxZoomRatio >= 1 ? maxZoomRatio : 1;
  const safeMinimum = Number.isFinite(minimumZoomRatio)
    ? Math.min(safeMaximum, Math.max(1, minimumZoomRatio))
    : 1;
  const scale = Math.max(current.scale, fit.scale * safeMinimum);
  const x = Math.min(sceneSize, Math.max(0, point.x));
  const y = Math.min(sceneSize, Math.max(0, point.y));

  return clampMapCamera(
    {
      scale,
      x: viewportWidth / 2 - x * scale,
      y: viewportHeight / 2 - y * scale,
    },
    viewportWidth,
    viewportHeight,
    sceneSize,
    maxZoomRatio,
  );
}

/** Zoom around a viewport-space anchor so the point under the cursor/fingers stays fixed. */
export function zoomMapCameraAt(
  camera: MapCamera,
  targetScale: number,
  anchorX: number,
  anchorY: number,
  viewportWidth: number,
  viewportHeight: number,
  sceneSize = MAP_SCENE_SIZE,
  maxZoomRatio = MAP_MAX_ZOOM_RATIO,
): MapCamera {
  const current = clampMapCamera(camera, viewportWidth, viewportHeight, sceneSize, maxZoomRatio);
  const fit = fitMapCamera(viewportWidth, viewportHeight, sceneSize);
  const safeRatio = Number.isFinite(maxZoomRatio) && maxZoomRatio >= 1 ? maxZoomRatio : 1;
  const scale = Math.min(
    fit.scale * safeRatio,
    Math.max(fit.scale, Number.isFinite(targetScale) ? targetScale : current.scale),
  );
  const ratio = scale / current.scale;
  const x = Number.isFinite(anchorX) ? anchorX : viewportWidth / 2;
  const y = Number.isFinite(anchorY) ? anchorY : viewportHeight / 2;

  return clampMapCamera(
    {
      scale,
      x: x - (x - current.x) * ratio,
      y: y - (y - current.y) * ratio,
    },
    viewportWidth,
    viewportHeight,
    sceneSize,
    maxZoomRatio,
  );
}

/** Compact world-coordinate label, e.g. `-359583` → `-360k`. */
export function formatWorldCoordinate(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * Choose a grid step (in world units) that yields roughly `targetLines` divisions across
 * `span`, snapped to a 1/2/5 × 10ⁿ progression so labels stay round.
 */
export function niceGridStep(span: number, targetLines = 8): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, targetLines);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** One grid line: its world coordinate and its normalised position across the viewport. */
export interface GridLine {
  value: number;
  /** 0 at the left/bottom edge, 1 at the right/top edge. */
  position: number;
}

/**
 * Grid lines for one axis of the abstract plot.
 *
 * Positions are normalised to `[0, 1]` and already flipped for the Y axis, so the caller maps
 * them straight onto SVG coordinates. Values are generated by integer index (`i * step`) rather
 * than by repeated addition, which would accumulate floating-point drift over many lines.
 */
export function gridLines(bounds: Bounds, axis: 'x' | 'y', targetLines = 8): GridLine[] {
  const min = axis === 'x' ? bounds.minX : bounds.minY;
  const max = axis === 'x' ? bounds.maxX : bounds.maxY;
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [];

  const step = niceGridStep(span, targetLines);
  const firstIndex = Math.ceil(min / step);
  const lastIndex = Math.floor(max / step);

  const lines: GridLine[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const value = index * step;
    const position = (value - min) / span;
    // Screen Y grows downward while world Y grows upward.
    lines.push({ value, position: axis === 'y' ? 1 - position : position });
  }
  return lines;
}
