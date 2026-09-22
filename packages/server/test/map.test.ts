import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_BOUNDS,
  DEFAULT_MAP_PROJECTION,
  DEFAULT_MAP_TEXTURE_URL,
  DEFAULT_WORLD_TREE_TEXTURE_URL,
  IDENTITY_CALIBRATION,
  MAP_LAYERS,
  MAP_MAX_ZOOM_RATIO,
  MAP_PROJECTION_CONSTANTS,
  PALPAGOS_BOUNDS,
  WORLD_TREE_BOUNDS,
  boundsOf,
  clampMapCamera,
  fitMapCamera,
  focusMapCamera,
  formatWorldCoordinate,
  gridLines,
  lerpBounds,
  mapLayerForPoint,
  mapSpaceToTexture,
  mapSpaceToWorld,
  niceGridStep,
  panMapCamera,
  projectToMapLayer,
  projectToViewport,
  worldToMapSpace,
  zoomMapCameraAt,
  type Bounds,
} from '@palsentry/shared';

/**
 * Tests for the map maths in `@palsentry/shared`.
 *
 * These live in the server workspace because it is the one with a test runner wired up, but they
 * cover code the browser uses too — the projection is exactly the kind of arithmetic that is
 * easy to get subtly wrong and hard to spot by eye.
 */

/** A real coordinate pair observed from the Palworld REST API. */
const SAMPLE = { x: -359_583, y: 267_748.59375 };

describe('default map textures', () => {
  it('points at the two WebP assets bundled with the SPA', () => {
    assert.equal(DEFAULT_MAP_TEXTURE_URL, '/maps/T_WorldMap.webp');
    assert.equal(DEFAULT_WORLD_TREE_TEXTURE_URL, '/maps/T_TreeMap.webp');
    assert.deepEqual(
      MAP_LAYERS.map((layer) => layer.id),
      ['palpagos', 'worldTree'],
    );
  });

  it('pairs the default texture with a real projection', () => {
    assert.notEqual(
      DEFAULT_MAP_PROJECTION,
      'none',
      'the default map must not fall back to the grid',
    );
    assert.ok(DEFAULT_MAP_PROJECTION in MAP_PROJECTION_CONSTANTS);
  });
});

describe('worldToMapSpace', () => {
  it('returns null for the "none" projection so callers fall back to the grid', () => {
    assert.equal(worldToMapSpace(0, 0, 'none'), null);
    assert.equal(mapSpaceToWorld(0, 0, 'none'), null);
  });

  it('applies the documented "new" (Palworld 1.0+) transform with swapped axes', () => {
    const point = worldToMapSpace(SAMPLE.x, SAMPLE.y, 'new');
    assert.ok(point !== null);

    const { tx, ty, scale } = MAP_PROJECTION_CONSTANTS.new;
    // newX = worldX + tx, newY = worldY - ty, then X follows newY and Y follows newX.
    assert.equal(point.x, (SAMPLE.y - ty) / scale);
    assert.equal(point.y, (SAMPLE.x + tx) / scale);

    // Concretely: (267748.59375 + 18) / 725 and (-359583 + 375247) / 725.
    assert.ok(Math.abs(point.x - 369.3332) < 0.001, `got x=${point.x}`);
    assert.ok(Math.abs(point.y - 21.6055) < 0.001, `got y=${point.y}`);
  });

  it('uses different constants for the legacy map generation', () => {
    const modern = worldToMapSpace(SAMPLE.x, SAMPLE.y, 'new');
    const legacy = worldToMapSpace(SAMPLE.x, SAMPLE.y, 'legacy');

    assert.ok(modern !== null && legacy !== null);
    assert.notDeepEqual(modern, legacy, 'legacy maps must not reuse the new calibration');
  });

  it('round-trips through mapSpaceToWorld', () => {
    for (const projection of ['new', 'legacy'] as const) {
      const mapPoint = worldToMapSpace(SAMPLE.x, SAMPLE.y, projection);
      assert.ok(mapPoint !== null);

      const back = mapSpaceToWorld(mapPoint.x, mapPoint.y, projection);
      assert.ok(back !== null);
      assert.ok(Math.abs(back.x - SAMPLE.x) < 1e-6, `${projection}: x drift`);
      assert.ok(Math.abs(back.y - SAMPLE.y) < 1e-6, `${projection}: y drift`);
    }
  });
});

describe('mapSpaceToTexture', () => {
  const SIZE = 8_192;

  it('puts map-space origin at the centre of the texture', () => {
    const pixel = mapSpaceToTexture({ x: 0, y: 0 }, IDENTITY_CALIBRATION, SIZE, SIZE);
    assert.equal(Math.round(pixel.x), SIZE / 2);
    assert.equal(Math.round(pixel.y), SIZE / 2);
  });

  it('applies the vertical flip — higher world Y maps to a smaller pixel Y', () => {
    const above = mapSpaceToTexture({ x: 0, y: 500 }, IDENTITY_CALIBRATION, SIZE, SIZE);
    const below = mapSpaceToTexture({ x: 0, y: -500 }, IDENTITY_CALIBRATION, SIZE, SIZE);
    assert.ok(above.y < below.y, 'the map grows upward, the texture downward');
  });

  it('honours the calibration offsets and scale', () => {
    const base = mapSpaceToTexture({ x: 100, y: 100 }, IDENTITY_CALIBRATION, SIZE, SIZE);
    const nudged = mapSpaceToTexture(
      { x: 100, y: 100 },
      { offsetX: 10, offsetY: -20, scale: 1 },
      SIZE,
      SIZE,
    );

    assert.equal(nudged.x, base.x + 10);
    assert.equal(nudged.y, base.y - 20);
  });
});

describe('map layers', () => {
  it('classifies points in each native map and rejects coordinates outside both', () => {
    assert.equal(mapLayerForPoint({ x: -359_583, y: 267_748 }), 'palpagos');
    assert.equal(mapLayerForPoint({ x: 500_000, y: -650_000 }), 'worldTree');
    assert.equal(mapLayerForPoint({ x: 900_000, y: 900_000 }), null);
    assert.equal(mapLayerForPoint({ x: Number.NaN, y: 0 }), null);
  });

  it('gives World Tree precedence in the narrow coordinate overlap', () => {
    assert.equal(mapLayerForPoint({ x: 348_000, y: -500_000 }), 'worldTree');
  });

  it('projects swapped axes to the texture corners and centre', () => {
    for (const [id, bounds] of [
      ['palpagos', PALPAGOS_BOUNDS],
      ['worldTree', WORLD_TREE_BOUNDS],
    ] as const) {
      assert.deepEqual(projectToMapLayer({ x: bounds.maxX, y: bounds.minY }, id), { x: 0, y: 0 });
      assert.deepEqual(projectToMapLayer({ x: bounds.minX, y: bounds.maxY }, id), { x: 1, y: 1 });
      const centre = projectToMapLayer(
        { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
        id,
      );
      assert.deepEqual(centre, { x: 0.5, y: 0.5 });
    }
  });

  it('does not project a point onto the wrong region', () => {
    assert.equal(projectToMapLayer({ x: 500_000, y: -650_000 }, 'palpagos'), null);
  });
});

describe('map camera', () => {
  it('fits and centres the complete square scene', () => {
    assert.deepEqual(fitMapCamera(800, 600), { x: 100, y: 0, scale: 0.6 });
    assert.deepEqual(fitMapCamera(600, 800), { x: 0, y: 100, scale: 0.6 });
  });

  it('clamps scale and panning to the viewport edges', () => {
    assert.deepEqual(clampMapCamera({ x: 999, y: -999, scale: 0.1 }, 800, 600), {
      x: 100,
      y: 0,
      scale: 0.6,
    });
    assert.deepEqual(clampMapCamera({ x: -2_000, y: 500, scale: 1.2 }, 800, 600), {
      x: -400,
      y: 0,
      scale: 1.2,
    });
  });

  it('pans by screen pixels before clamping', () => {
    const camera = panMapCamera({ x: -100, y: -100, scale: 1 }, 40, -20, 500, 500);
    assert.deepEqual(camera, { x: -60, y: -120, scale: 1 });
  });

  it('keeps the scene point under the zoom anchor stationary', () => {
    const camera = zoomMapCameraAt({ x: 0, y: 0, scale: 1 }, 2, 250, 300, 1_000, 1_000);
    assert.deepEqual(camera, { x: -250, y: -300, scale: 2 });
    assert.equal((250 - camera.x) / camera.scale, 250);
    assert.equal((300 - camera.y) / camera.scale, 300);
  });

  it('focuses a scene point at a minimum zoom while preserving closer zoom', () => {
    assert.deepEqual(
      focusMapCamera({ x: 0, y: 0, scale: 1 }, { x: 400, y: 600 }, 1_000, 1_000, 2.5),
      { x: -500, y: -1_000, scale: 2.5 },
    );
    assert.deepEqual(
      focusMapCamera({ x: -50, y: -50, scale: 4 }, { x: 500, y: 500 }, 1_000, 1_000, 2.5),
      { x: -1_500, y: -1_500, scale: 4 },
    );
  });

  it('clamps focused edge points and ignores invalid points', () => {
    assert.deepEqual(focusMapCamera({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 1_000, 1_000, 2.5), {
      x: 0,
      y: 0,
      scale: 2.5,
    });
    assert.deepEqual(
      focusMapCamera({ x: -100, y: -100, scale: 2 }, { x: Number.NaN, y: 500 }, 1_000, 1_000),
      { x: -100, y: -100, scale: 2 },
    );
  });

  it('caps zoom at the configured ratio', () => {
    const camera = zoomMapCameraAt({ x: 0, y: 0, scale: 1 }, 100, 500, 500, 1_000, 1_000);
    // Compared against the exported cap rather than a literal, so retuning the cap cannot leave
    // this assertion behind asserting yesterday's value.
    assert.equal(camera.scale, MAP_MAX_ZOOM_RATIO);
  });
});

describe('boundsOf', () => {
  it('returns the default viewport when nobody is online', () => {
    assert.deepEqual(boundsOf([]), DEFAULT_BOUNDS);
  });

  it('expands a single point into a usable viewport instead of a zero-width box', () => {
    const bounds = boundsOf([{ x: 100, y: 200 }]);
    assert.ok(bounds.maxX > bounds.minX, 'width must be positive or the plot divides by zero');
    assert.ok(bounds.maxY > bounds.minY);
    // The point sits at the centre of the padded box.
    assert.ok(Math.abs((bounds.minX + bounds.maxX) / 2 - 100) < 1e-6);
    assert.ok(Math.abs((bounds.minY + bounds.maxY) / 2 - 200) < 1e-6);
  });

  it('handles every player standing at exactly the same spot', () => {
    const bounds = boundsOf([
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]);
    assert.ok(bounds.maxX > bounds.minX);
    assert.ok(bounds.maxY > bounds.minY);
  });

  it('contains all supplied points with padding around them', () => {
    const points = [
      { x: -100_000, y: -50_000 },
      { x: 200_000, y: 300_000 },
      { x: 0, y: 0 },
    ];
    const bounds = boundsOf(points, 0.1);

    for (const point of points) {
      assert.ok(point.x >= bounds.minX && point.x <= bounds.maxX, 'x within bounds');
      assert.ok(point.y >= bounds.minY && point.y <= bounds.maxY, 'y within bounds');
    }
    assert.ok(bounds.minX < -100_000, 'padding extends past the extreme point');
    assert.ok(bounds.maxY > 300_000);
  });

  it('falls back when every coordinate is non-finite', () => {
    const bounds = boundsOf([{ x: Number.NaN, y: Number.POSITIVE_INFINITY }]);
    assert.deepEqual(bounds, DEFAULT_BOUNDS);
  });

  it('ignores non-finite coordinates while still using the valid ones', () => {
    const bounds = boundsOf([
      { x: Number.NaN, y: 0 },
      { x: 1_000, y: 1_000 },
      { x: 2_000, y: Number.NEGATIVE_INFINITY },
    ]);
    assert.ok(Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX));
    assert.ok(bounds.minX <= 1_000 && bounds.maxX >= 1_000);
  });

  it('never produces an inverted box', () => {
    for (const points of [
      [],
      [{ x: 0, y: 0 }],
      [
        { x: -1, y: -1 },
        { x: 1, y: 1 },
      ],
    ]) {
      const bounds = boundsOf(points);
      assert.ok(bounds.maxX >= bounds.minX, 'maxX must not be below minX');
      assert.ok(bounds.maxY >= bounds.minY, 'maxY must not be below minY');
    }
  });
});

describe('projectToViewport', () => {
  const bounds: Bounds = { minX: -100, maxX: 100, minY: -100, maxY: 100 };

  it('maps the centre to (0.5, 0.5)', () => {
    const point = projectToViewport({ x: 0, y: 0 }, bounds);
    assert.equal(point.x, 0.5);
    assert.equal(point.y, 0.5);
  });

  it('puts the corners at the viewport extents', () => {
    assert.deepEqual(projectToViewport({ x: -100, y: 100 }, bounds), { x: 0, y: 0 });
    assert.deepEqual(projectToViewport({ x: 100, y: -100 }, bounds), { x: 1, y: 1 });
  });

  it('inverts Y so larger world Y appears higher on screen', () => {
    const high = projectToViewport({ x: 0, y: 50 }, bounds);
    const low = projectToViewport({ x: 0, y: -50 }, bounds);
    assert.ok(high.y < low.y, 'a smaller viewport Y means higher up the screen');
  });

  it('does not divide by zero on a degenerate viewport', () => {
    const degenerate: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const point = projectToViewport({ x: 0, y: 0 }, degenerate);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  });
});

describe('lerpBounds', () => {
  const from: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  const to: Bounds = { minX: 100, maxX: 200, minY: 100, maxY: 200 };

  it('returns the endpoints at t=0 and t=1', () => {
    assert.deepEqual(lerpBounds(from, to, 0), from);
    assert.deepEqual(lerpBounds(from, to, 1), to);
  });

  it('interpolates linearly in between', () => {
    assert.deepEqual(lerpBounds(from, to, 0.5), { minX: 50, maxX: 105, minY: 50, maxY: 105 });
  });

  it('clamps out-of-range t so a lagging animation cannot overshoot', () => {
    assert.deepEqual(lerpBounds(from, to, -1), from);
    assert.deepEqual(lerpBounds(from, to, 5), to);
  });
});

describe('niceGridStep', () => {
  it('snaps to 1/2/5 × 10ⁿ so labels stay round', () => {
    const cases: [number, number][] = [
      [1_000, 100],
      [10_000, 1_000],
      [100_000, 10_000],
      [1_000_000, 100_000],
      [2_000_000, 200_000],
      [500_000, 50_000],
    ];
    for (const [span, expected] of cases) {
      assert.equal(niceGridStep(span, 10), expected, `span ${span}`);
    }
  });

  it('returns a usable step for degenerate spans', () => {
    assert.equal(niceGridStep(0), 1);
    assert.equal(niceGridStep(-5), 1);
    assert.equal(niceGridStep(Number.NaN), 1);
  });
});

describe('gridLines', () => {
  const bounds: Bounds = { minX: -100, maxX: 100, minY: -100, maxY: 100 };

  it('includes the origin for a symmetric viewport', () => {
    const values = gridLines(bounds, 'x', 4).map((line) => line.value);
    assert.ok(values.includes(0), `expected a line at 0, got ${values.join(', ')}`);
  });

  it('produces strictly increasing positions across the axis', () => {
    const lines = gridLines(bounds, 'x', 4);
    for (let index = 1; index < lines.length; index += 1) {
      assert.ok((lines[index]?.position ?? 0) > (lines[index - 1]?.position ?? 0));
    }
  });

  it('flips the Y axis so higher values map to smaller positions', () => {
    const lines = gridLines(bounds, 'y', 4);
    for (let index = 1; index < lines.length; index += 1) {
      assert.ok(
        (lines[index]?.position ?? 0) < (lines[index - 1]?.position ?? 0),
        'Y positions must decrease as the world value increases',
      );
    }
  });

  it('keeps every position inside the viewport', () => {
    const wide: Bounds = { minX: -923_456, maxX: 311_111, minY: -750_000, maxY: 820_000 };
    for (const axis of ['x', 'y'] as const) {
      for (const line of gridLines(wide, axis, 8)) {
        assert.ok(line.position >= 0 && line.position <= 1, `${axis} position ${line.position}`);
      }
    }
  });

  it('scales the number of lines with the requested target', () => {
    const few = gridLines(bounds, 'x', 2).length;
    const many = gridLines(bounds, 'x', 20).length;
    assert.ok(many > few, `expected more lines for a denser target (got ${few} vs ${many})`);
  });

  it('returns nothing for a degenerate span', () => {
    assert.deepEqual(gridLines({ minX: 5, maxX: 5, minY: 0, maxY: 0 }, 'x'), []);
  });
});

describe('formatWorldCoordinate', () => {
  it('abbreviates thousands and millions', () => {
    assert.equal(formatWorldCoordinate(0), '0');
    assert.equal(formatWorldCoordinate(999), '999');
    assert.equal(formatWorldCoordinate(1_000), '1k');
    assert.equal(formatWorldCoordinate(-359_583), '-360k');
    assert.equal(formatWorldCoordinate(1_500_000), '1.5M');
    assert.equal(formatWorldCoordinate(-2_000_000), '-2.0M');
  });
});
