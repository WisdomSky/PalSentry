<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Crosshair,
  House,
  ImageOff,
  MapPin,
  Maximize2,
  Minus,
  Plus,
  SlidersHorizontal,
} from '@lucide/vue';
import {
  IDENTITY_CALIBRATION,
  MAP_LAYERS,
  MAP_SCENE_SIZE,
  formatWorldCoordinate,
  gridLines,
  mapLayerById,
  mapLayerForPoint,
  mapSpaceToTexture,
  projectToMapLayer,
  worldToMapSpace,
  type OnlineEnrichedPlayer,
  type MapCalibration,
  type MapLayerId,
  type MapMeta,
  type MapPoint,
  type PalworldGuildBase,
} from '@palsentry/shared';
import { useMapViewport } from '@/composables/useMapViewport';
import { pingTone } from '@/lib/format';

const props = withDefaults(
  defineProps<{
    /** Connected players only: the camera and check-in pins describe the live world. */
    players: OnlineEnrichedPlayer[];
    bases?: PalworldGuildBase[];
    basesAvailable?: boolean;
    online: boolean;
    map: MapMeta;
    /** When set, the camera follows this account and follows it across regions. */
    trackedUserId?: string | null;
  }>(),
  {
    bases: () => [],
    basesAvailable: false,
    trackedUserId: null,
  },
);

/** Follow zoom as a multiple of the fitted scale, when tracking starts or the target teleports. */
const TRACK_MIN_ZOOM_RATIO = 2.5;

const LEGACY_CALIBRATION_KEY = 'palsentry:mapCalibration';
const CALIBRATION_KEY = 'palsentry:mapCalibration:v2';
type CalibrationByLayer = Record<MapLayerId, MapCalibration>;

function normaliseCalibration(value: unknown): MapCalibration {
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

function readCalibrations(): CalibrationByLayer {
  const defaults: CalibrationByLayer = {
    palpagos: { ...IDENTITY_CALIBRATION },
    worldTree: { ...IDENTITY_CALIBRATION },
  };

  try {
    const stored = localStorage.getItem(CALIBRATION_KEY);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<Record<MapLayerId, unknown>>;
      return {
        palpagos: normaliseCalibration(parsed.palpagos),
        worldTree: normaliseCalibration(parsed.worldTree),
      };
    }

    const legacy = localStorage.getItem(LEGACY_CALIBRATION_KEY);
    if (legacy !== null) defaults.palpagos = normaliseCalibration(JSON.parse(legacy));
  } catch {
    // A corrupt browser value should never stop the map from rendering.
  }

  return defaults;
}

const activeLayer = ref<MapLayerId>('palpagos');
const calibrations = ref<CalibrationByLayer>(readCalibrations());
const calibration = computed(() => calibrations.value[activeLayer.value]);
const showCalibration = ref(false);
const failedTextureUrl = ref<Record<MapLayerId, string | null>>({
  palpagos: null,
  worldTree: null,
});
const selectedBaseId = ref<string | null>(null);
const hoveredBaseId = ref<string | null>(null);
const focusedBaseId = ref<string | null>(null);
const visibleBaseTooltipId = computed(
  () => focusedBaseId.value ?? hoveredBaseId.value ?? selectedBaseId.value,
);

watch(calibrations, (value) => localStorage.setItem(CALIBRATION_KEY, JSON.stringify(value)), {
  deep: true,
});

function resetCalibration(): void {
  calibrations.value[activeLayer.value] = { ...IDENTITY_CALIBRATION };
}

function tabId(layer: MapLayerId): string {
  return `world-map-tab-${layer}`;
}

function panelId(layer: MapLayerId): string {
  return `world-map-panel-${layer}`;
}

function selectLayer(layer: MapLayerId): void {
  activeLayer.value = layer;
}

async function onTabKeydown(event: KeyboardEvent, index: number): Promise<void> {
  let nextIndex: number | null = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (index + 1) % MAP_LAYERS.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (index - 1 + MAP_LAYERS.length) % MAP_LAYERS.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = MAP_LAYERS.length - 1;
  }
  if (nextIndex === null) return;

  event.preventDefault();
  const layer = MAP_LAYERS[nextIndex];
  if (layer === undefined) return;
  selectLayer(layer.id);
  await nextTick();
  document.getElementById(tabId(layer.id))?.focus();
}

function tooltipId(baseId: string): string {
  return `base-owner-${baseId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function selectBase(baseId: string): void {
  selectedBaseId.value = baseId;
}

function closeBaseTooltip(): void {
  selectedBaseId.value = null;
  hoveredBaseId.value = null;
  focusedBaseId.value = null;
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest('[data-base-marker]') !== null) return;
  if (
    document.activeElement instanceof HTMLElement &&
    document.activeElement.matches('[data-base-marker]')
  ) {
    document.activeElement.blur();
  }
  closeBaseTooltip();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeBaseTooltip();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
});

watch(activeLayer, () => {
  closeBaseTooltip();
  showCalibration.value = false;
});

const viewportElement = ref<HTMLElement | null>(null);
const mapViewport = useMapViewport(activeLayer, viewportElement);
const {
  camera,
  sceneStyle,
  zoomPercent,
  canZoomIn,
  canZoomOut,
  dragging,
  fit: fitMap,
  focusOn,
  zoomIn,
  zoomOut,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  onKeydown,
} = mapViewport;

const activeDefinition = computed(() => mapLayerById(activeLayer.value));
const activeTextureUrl = computed(() => props.map.layers[activeLayer.value].textureUrl);
const textureFailed = computed(
  () =>
    activeTextureUrl.value !== null &&
    failedTextureUrl.value[activeLayer.value] === activeTextureUrl.value,
);
const textureMode = computed(
  () =>
    props.map.projection !== 'none' &&
    activeTextureUrl.value !== null &&
    activeTextureUrl.value !== '' &&
    !textureFailed.value,
);

function onTextureError(): void {
  failedTextureUrl.value[activeLayer.value] = activeTextureUrl.value;
}

function onTextureLoad(): void {
  failedTextureUrl.value[activeLayer.value] = null;
}

function applyCalibrationOnLayer(layer: MapLayerId, point: MapPoint): MapPoint {
  const value = calibrations.value[layer];
  return {
    x: (point.x * value.scale + value.offsetX / 100) * MAP_SCENE_SIZE,
    y: (point.y * value.scale + value.offsetY / 100) * MAP_SCENE_SIZE,
  };
}

function textureModeFor(layer: MapLayerId): boolean {
  const url = props.map.layers[layer].textureUrl;
  return (
    props.map.projection !== 'none' &&
    url !== null &&
    url !== '' &&
    failedTextureUrl.value[layer] !== url
  );
}

/**
 * Project a world position onto one named layer, regardless of which tab is showing.
 *
 * Tracking needs this: while following a player the active tab lags one update behind a teleport,
 * so `projectLocation` (which only answers for the active tab) would report `null` exactly when
 * the cross-region switch has to be detected.
 */
function projectLocationOnLayer(
  layer: MapLayerId,
  worldX: number,
  worldY: number,
): MapPoint | null {
  if (mapLayerForPoint({ x: worldX, y: worldY }) !== layer) return null;

  // Keep the established new/legacy affine path for custom Palpagos textures.
  if (layer === 'palpagos' && textureModeFor(layer)) {
    const mapPoint = worldToMapSpace(worldX, worldY, props.map.projection);
    if (mapPoint === null) return null;
    const percent = mapSpaceToTexture(mapPoint, calibrations.value[layer], 100, 100);
    return {
      x: (percent.x / 100) * MAP_SCENE_SIZE,
      y: (percent.y / 100) * MAP_SCENE_SIZE,
    };
  }

  const normalized = projectToMapLayer({ x: worldX, y: worldY }, layer);
  return normalized === null ? null : applyCalibrationOnLayer(layer, normalized);
}

function projectLocation(worldX: number, worldY: number): MapPoint | null {
  return projectLocationOnLayer(activeLayer.value, worldX, worldY);
}

interface PlayerPin {
  player: OnlineEnrichedPlayer;
  position: MapPoint;
}

interface BasePin {
  base: PalworldGuildBase;
  position: MapPoint;
}

const playerPins = computed<PlayerPin[]>(() =>
  props.players.flatMap((player) => {
    const position = projectLocation(player.location_x, player.location_y);
    return position === null ? [] : [{ player, position }];
  }),
);

const basePins = computed<BasePin[]>(() =>
  props.bases.flatMap((base) => {
    const position = projectLocation(base.location_x, base.location_y);
    return position === null ? [] : [{ base, position }];
  }),
);

interface LayerCounts {
  players: number;
  bases: number;
}

const layerCounts = computed<Record<MapLayerId, LayerCounts>>(() => {
  const counts: Record<MapLayerId, LayerCounts> = {
    palpagos: { players: 0, bases: 0 },
    worldTree: { players: 0, bases: 0 },
  };
  for (const player of props.players) {
    const layer = mapLayerForPoint({ x: player.location_x, y: player.location_y });
    if (layer !== null) counts[layer].players += 1;
  }
  for (const base of props.bases) {
    const layer = mapLayerForPoint({ x: base.location_x, y: base.location_y });
    if (layer !== null) counts[layer].bases += 1;
  }
  return counts;
});

function isTracked(player: OnlineEnrichedPlayer): boolean {
  return props.trackedUserId !== null && player.userId === props.trackedUserId;
}

/**
 * Where the followed player is *now*, resolved against their own region rather than the open tab.
 */
const trackTarget = computed<{
  player: OnlineEnrichedPlayer;
  layer: MapLayerId;
  position: MapPoint;
} | null>(() => {
  const id = props.trackedUserId;
  if (id === null || id === '') return null;

  const player = props.players.find((candidate) => candidate.userId === id);
  if (player === undefined) return null;

  const layer = mapLayerForPoint({ x: player.location_x, y: player.location_y });
  if (layer === null) return null;

  const position = projectLocationOnLayer(layer, player.location_x, player.location_y);
  return position === null ? null : { player, layer, position };
});

// Whichever target and region the follow last settled on, so a genuine teleport can be told apart
// from an ordinary position update.
let followedUserId: string | null = null;
let followedLayer: MapLayerId | null = null;

watch(
  () => {
    const target = trackTarget.value;
    return target === null
      ? null
      : ([target.player.userId, target.layer, target.position.x, target.position.y] as const);
  },
  async () => {
    const target = trackTarget.value;
    if (target === null) return;

    const isNewTarget = target.player.userId !== followedUserId || target.layer !== followedLayer;
    followedUserId = target.player.userId;
    followedLayer = target.layer;

    if (target.layer !== activeLayer.value) activeLayer.value = target.layer;

    // The region switch above creates/selects the per-region camera, so centre after it settles.
    await nextTick();
    focusOn(target.position, isNewTarget ? TRACK_MIN_ZOOM_RATIO : 1);
  },
  { immediate: true },
);

// A new follow target must not inherit the previous one's remembered region or teleport state.
watch(
  () => props.trackedUserId,
  (id) => {
    if (id !== null && id !== '') {
      followedUserId = null;
      followedLayer = null;
    }
  },
);

function handleViewportPointerDown(event: PointerEvent): void {
  closeBaseTooltip();
  viewportElement.value?.focus({ preventScroll: true });
  onPointerDown(event);
}

function handleViewportKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeBaseTooltip();
    event.preventDefault();
    return;
  }
  onKeydown(event);
}

function markerStyle(position: MapPoint): Record<string, string> {
  const inverseScale = camera.value.scale > 0 ? 1 / camera.value.scale : 1;
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
    transform: `translate(-50%, -50%) scale(${inverseScale})`,
    transformOrigin: 'center',
  };
}

interface SceneGridLine {
  value: number;
  position: number;
}

/** Horizontal texture position follows world Y; vertical position follows reversed world X. */
const xLines = computed<SceneGridLine[]>(() =>
  gridLines(activeDefinition.value.bounds, 'y', 8).map((line) => ({
    value: line.value,
    position: 1 - line.position,
  })),
);
const yLines = computed<SceneGridLine[]>(() =>
  gridLines(activeDefinition.value.bounds, 'x', 8).map((line) => ({
    value: line.value,
    position: 1 - line.position,
  })),
);
const origin = computed(() => projectToMapLayer({ x: 0, y: 0 }, activeLayer.value));

function scenePosition(normalized: number): number {
  return normalized * MAP_SCENE_SIZE;
}

const plottedCount = computed(() => playerPins.value.length + basePins.value.length);
const textureVariable = computed(() =>
  activeLayer.value === 'palpagos'
    ? 'PALSENTRY_MAP_TEXTURE_URL'
    : 'PALSENTRY_WORLD_TREE_TEXTURE_URL',
);
</script>

<template>
  <div class="space-y-2">
    <div
      class="inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
      role="tablist"
      aria-label="Map region"
    >
      <button
        v-for="(layer, index) in MAP_LAYERS"
        :id="tabId(layer.id)"
        :key="layer.id"
        type="button"
        role="tab"
        class="flex min-w-max items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
        :class="
          activeLayer === layer.id
            ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100'
            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
        "
        :aria-selected="activeLayer === layer.id"
        :aria-controls="panelId(layer.id)"
        :tabindex="activeLayer === layer.id ? 0 : -1"
        @click="selectLayer(layer.id)"
        @keydown="onTabKeydown($event, index)"
      >
        <span>{{ layer.label }}</span>
        <span
          class="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] tabular-nums dark:bg-slate-700"
          :aria-label="`${layerCounts[layer.id].players} players and ${layerCounts[layer.id].bases} bases`"
        >
          {{ layerCounts[layer.id].players }}P · {{ layerCounts[layer.id].bases }}B
        </span>
      </button>
    </div>

    <section
      :id="panelId(activeLayer)"
      role="tabpanel"
      class="space-y-2"
      :aria-labelledby="tabId(activeLayer)"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <MapPin class="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            {{ playerPins.length }} {{ playerPins.length === 1 ? 'player' : 'players' }} ·
            {{ basePins.length }} {{ basePins.length === 1 ? 'base' : 'bases' }} on
            {{ activeDefinition.label }}
          </span>
          <span v-if="!online" class="text-rose-600 dark:text-rose-400">· server offline</span>
          <span v-else-if="!basesAvailable" class="text-amber-600 dark:text-amber-400">
            · base layer unavailable
          </span>
        </div>

        <button
          v-if="textureMode"
          type="button"
          class="btn-ghost btn-xs"
          :aria-expanded="showCalibration"
          @click="showCalibration = !showCalibration"
        >
          <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
          Calibrate
        </button>
      </div>

      <div
        v-if="textureMode && showCalibration"
        class="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
      >
        <label class="block">
          <span class="label">Offset X</span>
          <input
            v-model.number="calibration.offsetX"
            class="input py-1 text-xs"
            type="number"
            step="0.5"
          />
        </label>
        <label class="block">
          <span class="label">Offset Y</span>
          <input
            v-model.number="calibration.offsetY"
            class="input py-1 text-xs"
            type="number"
            step="0.5"
          />
        </label>
        <label class="block">
          <span class="label">Scale</span>
          <input
            v-model.number="calibration.scale"
            class="input py-1 text-xs"
            type="number"
            step="0.01"
            min="0.5"
            max="2"
          />
        </label>
        <p class="col-span-3 text-xs text-slate-500 dark:text-slate-400">
          Nudge {{ activeDefinition.label }} markers if they look off. Saved in this browser only.
          <button
            type="button"
            class="underline hover:text-slate-700 dark:hover:text-slate-200"
            @click="resetCalibration"
          >
            Reset
          </button>
        </p>
      </div>

      <div
        ref="viewportElement"
        class="relative aspect-square w-full touch-none overflow-hidden rounded-xl border border-slate-200 bg-slate-50 select-none focus-visible:outline-offset-2 sm:aspect-[4/3] dark:border-slate-800 dark:bg-slate-900"
        :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
        role="application"
        tabindex="0"
        :aria-label="`${activeDefinition.label} interactive world map. Drag or use arrow keys to pan; use the mouse wheel, pinch gesture, or plus and minus keys to zoom.`"
        @pointerdown="handleViewportPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel="onWheel"
        @keydown="handleViewportKeydown"
      >
        <div class="absolute top-0 left-0" :style="sceneStyle">
          <img
            v-if="textureMode"
            :key="`${activeLayer}:${activeTextureUrl}`"
            :src="activeTextureUrl ?? ''"
            alt=""
            draggable="false"
            class="pointer-events-none absolute inset-0 h-full w-full object-cover"
            @load="onTextureLoad"
            @error="onTextureError"
          />

          <template v-else>
            <svg
              class="absolute inset-0 h-full w-full"
              :viewBox="`0 0 ${MAP_SCENE_SIZE} ${MAP_SCENE_SIZE}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <g class="text-slate-300 dark:text-slate-700" stroke="currentColor" stroke-width="1">
                <line
                  v-for="line in xLines"
                  :key="`x-${line.value}`"
                  :x1="scenePosition(line.position)"
                  y1="0"
                  :x2="scenePosition(line.position)"
                  :y2="MAP_SCENE_SIZE"
                  vector-effect="non-scaling-stroke"
                />
                <line
                  v-for="line in yLines"
                  :key="`y-${line.value}`"
                  :y1="scenePosition(line.position)"
                  x1="0"
                  :y2="scenePosition(line.position)"
                  :x2="MAP_SCENE_SIZE"
                  vector-effect="non-scaling-stroke"
                />
              </g>

              <g v-if="origin" class="text-teal-500/60" stroke="currentColor" stroke-width="2">
                <line
                  :x1="scenePosition(origin.x)"
                  :x2="scenePosition(origin.x)"
                  y1="0"
                  :y2="MAP_SCENE_SIZE"
                  vector-effect="non-scaling-stroke"
                />
                <line
                  x1="0"
                  :x2="MAP_SCENE_SIZE"
                  :y1="scenePosition(origin.y)"
                  :y2="scenePosition(origin.y)"
                  vector-effect="non-scaling-stroke"
                />
              </g>
            </svg>

            <div
              class="pointer-events-none absolute inset-0 text-[10px] text-slate-400 tabular-nums dark:text-slate-500"
              aria-hidden="true"
            >
              <span
                v-for="line in xLines"
                :key="`lx-${line.value}`"
                class="absolute bottom-1 -translate-x-1/2"
                :style="{ left: `${line.position * 100}%` }"
              >
                {{ formatWorldCoordinate(line.value) }}
              </span>
              <span
                v-for="line in yLines"
                :key="`ly-${line.value}`"
                class="absolute left-1 -translate-y-1/2"
                :style="{ top: `${line.position * 100}%` }"
              >
                {{ formatWorldCoordinate(line.value) }}
              </span>
            </div>
          </template>

          <div
            v-for="pin in playerPins"
            :key="pin.player.userId"
            class="group absolute"
            :class="isTracked(pin.player) ? 'z-20' : 'z-10'"
            :style="markerStyle(pin.position)"
            :data-tracked="isTracked(pin.player) ? 'true' : undefined"
          >
            <span
              v-if="isTracked(pin.player)"
              class="absolute -inset-2 rounded-full border-2 border-teal-400/80"
              aria-hidden="true"
            />
            <span
              class="block h-3 w-3 rounded-full border-2 border-white shadow-md transition-transform group-hover:scale-125 dark:border-slate-900"
              :class="pin.player.banned ? 'bg-rose-500' : 'bg-teal-500'"
            />
            <span
              class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap"
              :class="
                isTracked(pin.player)
                  ? 'bg-red-500 font-semibold text-white'
                  : 'bg-teal-600 text-white'
              "
            >
              {{ pin.player.name }}<template v-if="isTracked(pin.player)"> · Tracking</template>
            </span>
            <span
              class="pointer-events-none absolute top-9 left-1/2 hidden -translate-x-1/2 rounded bg-slate-900/95 px-2 py-1 text-[10px] whitespace-nowrap text-white shadow-lg group-hover:block"
            >
              Lv {{ pin.player.level }} ·
              <span :class="pingTone(pin.player.ping)">{{ Math.round(pin.player.ping) }}ms</span> ·
              {{ formatWorldCoordinate(pin.player.location_x) }},
              {{ formatWorldCoordinate(pin.player.location_y) }}
            </span>
          </div>

          <button
            v-for="pin in basePins"
            :key="pin.base.id"
            type="button"
            data-base-marker
            class="group absolute rounded-full focus-visible:outline-offset-2"
            :class="visibleBaseTooltipId === pin.base.id ? 'z-30' : 'z-20'"
            :style="markerStyle(pin.position)"
            :aria-label="`Base owned by ${pin.base.guildName}`"
            :aria-describedby="
              visibleBaseTooltipId === pin.base.id ? tooltipId(pin.base.id) : undefined
            "
            :aria-expanded="visibleBaseTooltipId === pin.base.id"
            @pointerdown.stop
            @click.stop="selectBase(pin.base.id)"
            @mouseenter="hoveredBaseId = pin.base.id"
            @mouseleave="hoveredBaseId = null"
            @focus="focusedBaseId = pin.base.id"
            @blur="focusedBaseId = null"
          >
            <span
              class="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-amber-300 text-amber-950 shadow-lg transition-transform group-hover:scale-110 dark:border-white"
            >
              <House class="h-4 w-4" aria-hidden="true" />
            </span>
            <span
              v-show="visibleBaseTooltipId === pin.base.id"
              :id="tooltipId(pin.base.id)"
              role="tooltip"
              class="pointer-events-none absolute top-9 left-1/2 -translate-x-1/2 rounded bg-slate-950/95 px-2 py-1 text-[11px] font-medium whitespace-nowrap text-white shadow-lg"
            >
              {{ pin.base.guildName }}
            </span>
          </button>
        </div>

        <div
          v-if="plottedCount === 0"
          class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
        >
          <component
            :is="online ? Crosshair : ImageOff"
            class="h-6 w-6 text-slate-300 dark:text-slate-700"
            aria-hidden="true"
          />
          <p class="text-xs text-slate-500 dark:text-slate-400">
            {{
              online
                ? '' /*`No live markers on ${activeDefinition.label}.`*/
                : 'Server offline — no positions available.'
            }}
          </p>
        </div>

        <div
          class="absolute top-2 right-2 z-30 flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"
          @pointerdown.stop
        >
          <button
            type="button"
            class="btn-ghost btn-xs px-2"
            :disabled="!canZoomOut"
            aria-label="Zoom out"
            @click="zoomOut"
          >
            <Minus class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <output
            class="min-w-11 text-center text-[10px] font-medium text-slate-600 tabular-nums dark:text-slate-300"
            aria-live="polite"
          >
            {{ zoomPercent }}%
          </output>
          <button
            type="button"
            class="btn-ghost btn-xs px-2"
            :disabled="!canZoomIn"
            aria-label="Zoom in"
            @click="zoomIn"
          >
            <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" class="btn-ghost btn-xs px-2" aria-label="Fit map" @click="fitMap">
            <Maximize2 class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <p v-if="textureFailed" class="text-xs text-amber-600 dark:text-amber-400">
        The {{ activeDefinition.label }} texture could not be loaded, so its coordinate grid is
        shown instead. Check <code class="font-mono">{{ textureVariable }}</code
        >.
      </p>
      <p v-else-if="!textureMode" class="text-xs text-slate-400 dark:text-slate-500">
        Interactive plot of raw world coordinates. Set
        <code class="font-mono">PALSENTRY_MAP_PROJECTION</code> to
        <code class="font-mono">new</code> or <code class="font-mono">legacy</code> to use textures.
      </p>
    </section>
  </div>
</template>
