import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';
import {
  MAP_MAX_ZOOM_RATIO,
  MAP_SCENE_SIZE,
  clampMapCamera,
  fitMapCamera,
  focusMapCamera,
  panMapCamera,
  zoomMapCameraAt,
  type MapCamera,
  type MapLayerId,
  type MapPoint,
} from '@palsentry/shared';

interface ViewportSize {
  width: number;
  height: number;
}

interface PointerPosition {
  x: number;
  y: number;
}

export interface UseMapViewportResult {
  viewport: Ref<HTMLElement | null>;
  camera: ComputedRef<MapCamera>;
  sceneStyle: ComputedRef<Record<string, string>>;
  zoomPercent: ComputedRef<number>;
  canZoomIn: ComputedRef<boolean>;
  canZoomOut: ComputedRef<boolean>;
  dragging: Ref<boolean>;
  fit: () => void;
  /** Center a scene point, raising zoom to `minimumZoomRatio` × fit if it is currently lower. */
  focusOn: (point: MapPoint, minimumZoomRatio?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onWheel: (event: WheelEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
}

const LAYERS: readonly MapLayerId[] = ['palpagos', 'worldTree'];
const KEYBOARD_PAN_PX = 64;
const ZOOM_STEP = 1.25;

/**
 * Camera and gesture controller for the square world-map scene.
 *
 * Each region owns an independent camera. Pointer Events cover mouse, pen, and touch with one
 * implementation; two live pointers become a midpoint-preserving pinch gesture.
 */
export function useMapViewport(
  activeLayer: Ref<MapLayerId>,
  viewport: Ref<HTMLElement | null> = ref(null),
): UseMapViewportResult {
  const viewportSize = ref<ViewportSize>({ width: 0, height: 0 });
  const cameras = reactive<Record<MapLayerId, MapCamera | null>>({
    palpagos: null,
    worldTree: null,
  });
  const pointers = new Map<number, PointerPosition>();
  const dragging = ref(false);
  let resizeObserver: ResizeObserver | null = null;

  /**
   * A focus request that arrived before the viewport had a measurable size.
   *
   * Map tracking can target a player during the very first render, when the element still
   * reports 0×0; without this the follow would silently do nothing until the next poll.
   */
  let pendingFocus: { point: MapPoint; minimumZoomRatio: number } | null = null;

  function fitted(size = viewportSize.value): MapCamera {
    return fitMapCamera(size.width, size.height, MAP_SCENE_SIZE);
  }

  function current(layer = activeLayer.value): MapCamera {
    return cameras[layer] ?? fitted();
  }

  function setCamera(next: MapCamera, layer = activeLayer.value): void {
    const size = viewportSize.value;
    cameras[layer] = clampMapCamera(
      next,
      size.width,
      size.height,
      MAP_SCENE_SIZE,
      MAP_MAX_ZOOM_RATIO,
    );
  }

  function resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    const previousSize = viewportSize.value;
    const hadSize = previousSize.width > 0 && previousSize.height > 0;
    viewportSize.value = { width, height };

    for (const layer of LAYERS) {
      const previous = cameras[layer];
      if (previous === null || !hadSize) {
        cameras[layer] = fitMapCamera(width, height, MAP_SCENE_SIZE);
        continue;
      }

      const previousFit = fitMapCamera(previousSize.width, previousSize.height, MAP_SCENE_SIZE);
      const nextFit = fitMapCamera(width, height, MAP_SCENE_SIZE);
      const zoomRatio = previous.scale / previousFit.scale;
      const sceneCentreX = (previousSize.width / 2 - previous.x) / previous.scale;
      const sceneCentreY = (previousSize.height / 2 - previous.y) / previous.scale;
      const scale = nextFit.scale * zoomRatio;

      cameras[layer] = clampMapCamera(
        {
          scale,
          x: width / 2 - sceneCentreX * scale,
          y: height / 2 - sceneCentreY * scale,
        },
        width,
        height,
        MAP_SCENE_SIZE,
        MAP_MAX_ZOOM_RATIO,
      );
    }

    if (pendingFocus !== null) {
      const { point, minimumZoomRatio } = pendingFocus;
      pendingFocus = null;
      focusOn(point, minimumZoomRatio);
    }
  }

  function fit(): void {
    cameras[activeLayer.value] = fitted();
  }

  function focusOn(point: MapPoint, minimumZoomRatio = 1): void {
    const size = viewportSize.value;
    if (size.width <= 0 || size.height <= 0) {
      pendingFocus = { point, minimumZoomRatio };
      return;
    }

    setCamera(
      focusMapCamera(
        current(),
        point,
        size.width,
        size.height,
        minimumZoomRatio,
        MAP_SCENE_SIZE,
        MAP_MAX_ZOOM_RATIO,
      ),
    );
  }

  function zoomAt(scale: number, viewportX: number, viewportY: number): void {
    const size = viewportSize.value;
    setCamera(
      zoomMapCameraAt(
        current(),
        scale,
        viewportX,
        viewportY,
        size.width,
        size.height,
        MAP_SCENE_SIZE,
        MAP_MAX_ZOOM_RATIO,
      ),
    );
  }

  function zoomBy(factor: number): void {
    const size = viewportSize.value;
    zoomAt(current().scale * factor, size.width / 2, size.height / 2);
  }

  function zoomIn(): void {
    zoomBy(ZOOM_STEP);
  }

  function zoomOut(): void {
    zoomBy(1 / ZOOM_STEP);
  }

  function panBy(deltaX: number, deltaY: number): void {
    const size = viewportSize.value;
    setCamera(
      panMapCamera(
        current(),
        deltaX,
        deltaY,
        size.width,
        size.height,
        MAP_SCENE_SIZE,
        MAP_MAX_ZOOM_RATIO,
      ),
    );
  }

  function midpoint(first: PointerPosition, second: PointerPosition): PointerPosition {
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  function distance(first: PointerPosition, second: PointerPosition): number {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function firstTwoPointers(): [PointerPosition, PointerPosition] | null {
    const values = [...pointers.values()];
    return values[0] !== undefined && values[1] !== undefined ? [values[0], values[1]] : null;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragging.value = true;
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const previousPosition = pointers.get(event.pointerId);
    if (previousPosition === undefined) return;

    const previousPair = firstTwoPointers();
    const nextPosition = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, nextPosition);

    if (pointers.size === 1) {
      panBy(nextPosition.x - previousPosition.x, nextPosition.y - previousPosition.y);
    } else if (previousPair !== null) {
      const nextPair = firstTwoPointers();
      if (nextPair !== null) {
        const oldDistance = distance(previousPair[0], previousPair[1]);
        const newDistance = distance(nextPair[0], nextPair[1]);
        const oldMidpoint = midpoint(previousPair[0], previousPair[1]);
        const newMidpoint = midpoint(nextPair[0], nextPair[1]);
        const rect = viewport.value?.getBoundingClientRect();
        const localX = oldMidpoint.x - (rect?.left ?? 0);
        const localY = oldMidpoint.y - (rect?.top ?? 0);

        if (oldDistance > 0 && newDistance > 0) {
          zoomAt(current().scale * (newDistance / oldDistance), localX, localY);
        }
        panBy(newMidpoint.x - oldMidpoint.x, newMidpoint.y - oldMidpoint.y);
      }
    }

    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    dragging.value = pointers.size > 0;
  }

  function onWheel(event: WheelEvent): void {
    const rect = viewport.value?.getBoundingClientRect();
    const x = event.clientX - (rect?.left ?? 0);
    const y = event.clientY - (rect?.top ?? 0);
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-delta * 0.0015);
    zoomAt(current().scale * factor, x, y);
    event.preventDefault();
  }

  function onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowLeft':
        panBy(KEYBOARD_PAN_PX, 0);
        break;
      case 'ArrowRight':
        panBy(-KEYBOARD_PAN_PX, 0);
        break;
      case 'ArrowUp':
        panBy(0, KEYBOARD_PAN_PX);
        break;
      case 'ArrowDown':
        panBy(0, -KEYBOARD_PAN_PX);
        break;
      case '+':
      case '=':
        zoomIn();
        break;
      case '-':
      case '_':
        zoomOut();
        break;
      case '0':
      case 'Home':
        fit();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const camera = computed(() => current());
  const zoomPercent = computed(() => {
    const fitScale = fitted().scale;
    return fitScale > 0 ? Math.round((camera.value.scale / fitScale) * 100) : 100;
  });
  const canZoomIn = computed(() => zoomPercent.value < MAP_MAX_ZOOM_RATIO * 100);
  const canZoomOut = computed(() => zoomPercent.value > 100);
  const sceneStyle = computed(() => ({
    width: `${MAP_SCENE_SIZE}px`,
    height: `${MAP_SCENE_SIZE}px`,
    transform: `translate3d(${camera.value.x}px, ${camera.value.y}px, 0) scale(${camera.value.scale})`,
    transformOrigin: '0 0',
  }));

  watch(activeLayer, () => {
    if (cameras[activeLayer.value] === null && viewportSize.value.width > 0) fit();
    pointers.clear();
    dragging.value = false;
  });

  onMounted(async () => {
    await nextTick();
    const element = viewport.value;
    if (element === null) return;

    resize(element.clientWidth, element.clientHeight);
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) resize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(element);
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    pointers.clear();
  });

  return {
    viewport,
    camera,
    sceneStyle,
    zoomPercent,
    canZoomIn,
    canZoomOut,
    dragging,
    fit,
    focusOn,
    zoomIn,
    zoomOut,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    onKeydown,
  };
}
