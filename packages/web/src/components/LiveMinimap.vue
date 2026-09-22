<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  MAP_SCENE_SIZE,
  gridLines,
  mapLayerById,
  type MapLayerId,
  type MapMeta,
  type MapPoint,
  type OnlineEnrichedPlayer,
} from '@palsentry/shared';
import {
  projectWorldToLayer,
  readCalibrations,
  textureModeFor,
  type CalibrationByLayer,
} from '@/lib/map-display';

/**
 * One region of the live world, drawn at a fixed full extent for the dashboard.
 *
 * This is deliberately not `WorldMap`: that component is a camera with tabs, gestures, tracking,
 * calibration controls, and base tooltips. A dashboard preview is a picture — the whole region,
 * always, with no way to change the view — so it owns none of that. What it does share is the
 * projection, texture selection, and saved calibration, so a player lands in the same spot here as
 * on the interactive map.
 */
const props = defineProps<{
  layer: MapLayerId;
  players: OnlineEnrichedPlayer[];
  map: MapMeta;
  /** True when the game server answered, so "nobody here" can be told from "unknown". */
  online: boolean;
}>();

/**
 * The saved nudges are read once, at setup.
 *
 * The previews never expose the calibration controls, so the only way these can change underneath
 * a mounted dashboard is another tab editing the same browser storage — not worth a storage
 * listener, and the map view remains the place where calibration is decided.
 */
const calibrations: CalibrationByLayer = readCalibrations();
const failedTextureUrl = ref<Record<MapLayerId, string | null>>({
  palpagos: null,
  worldTree: null,
});

const definition = computed(() => mapLayerById(props.layer));
const textureUrl = computed(() => props.map.layers[props.layer].textureUrl);
const textureMode = computed(() => textureModeFor(props.layer, props.map, failedTextureUrl.value));

const projectionContext = computed(() => ({
  map: props.map,
  calibrations,
  textureMode: {
    palpagos: textureModeFor('palpagos', props.map, failedTextureUrl.value),
    worldTree: textureModeFor('worldTree', props.map, failedTextureUrl.value),
  },
}));

interface PlayerPin {
  player: OnlineEnrichedPlayer;
  position: MapPoint;
}

/**
 * Only players standing in this region, projected once for both the marker and its label.
 *
 * A player whose coordinates fall outside every known region has no place on either preview, which
 * is honest: PalSentry does not know where they are, only what the game server reported.
 */
const pins = computed<PlayerPin[]>(() =>
  props.players.flatMap((player) => {
    const position = projectWorldToLayer(
      props.layer,
      player.location_x,
      player.location_y,
      projectionContext.value,
    );
    return position === null ? [] : [{ player, position }];
  }),
);

function scenePosition(normalized: number): number {
  return normalized * MAP_SCENE_SIZE;
}

/** The same coordinate grid the interactive map falls back to, without its axis labels. */
const xLines = computed(() =>
  gridLines(definition.value.bounds, 'y', 8).map((line) => ({
    value: line.value,
    position: 1 - line.position,
  })),
);
const yLines = computed(() =>
  gridLines(definition.value.bounds, 'x', 8).map((line) => ({
    value: line.value,
    position: 1 - line.position,
  })),
);

const origin = computed(() => projectWorldToLayer(props.layer, 0, 0, projectionContext.value));

/** Scene units are `MAP_SCENE_SIZE` across, and the preview shows the whole scene. */
function scenePercent(value: number): string {
  return `${(value / MAP_SCENE_SIZE) * 100}%`;
}

function markerStyle(position: MapPoint): Record<string, string> {
  return {
    left: scenePercent(position.x),
    top: scenePercent(position.y),
    transform: 'translate(-50%, -50%)',
  };
}

function onTextureError(): void {
  failedTextureUrl.value[props.layer] = textureUrl.value;
}
</script>

<template>
  <figure class="min-w-0 space-y-2">
    <div
      class="relative aspect-square w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
    >
      <img
        v-if="textureMode"
        :key="textureUrl ?? ''"
        :src="textureUrl ?? ''"
        alt=""
        draggable="false"
        class="pointer-events-none absolute inset-0 h-full w-full object-cover"
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
      </template>

      <!--
        Names are always visible rather than revealed on hover: the preview has no hover state, and
        an unlabelled dot would not answer "who is where?" at a glance.
      -->
      <div
        v-for="pin in pins"
        :key="pin.player.userId"
        class="absolute"
        :style="markerStyle(pin.position)"
      >
        <span
          class="block h-2.5 w-2.5 rounded-full border-2 border-white shadow-md dark:border-slate-900"
          :class="pin.player.banned ? 'bg-rose-500' : 'bg-teal-500'"
        />
        <span
          class="absolute top-3.5 left-1/2 -translate-x-1/2 rounded bg-slate-900/85 px-1 py-0.5 text-[9px] leading-tight font-medium whitespace-nowrap text-white"
        >
          {{ pin.player.name }}
        </span>
      </div>

      <!--      <p-->
      <!--        v-if="pins.length === 0"-->
      <!--        class="pointer-events-none absolute inset-x-0 bottom-0 bg-slate-50/85 px-2 py-1 text-center text-[10px] text-slate-500 dark:bg-slate-900/85 dark:text-slate-400"-->
      <!--      >-->
      <!--        <template v-if="!online">Server offline — positions unavailable.</template>-->
      <!--        <template v-else>Nobody here right now.</template>-->
      <!--      </p>-->
    </div>

    <figcaption class="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
      <span class="font-medium text-slate-700 dark:text-slate-200">{{ definition.label }}</span>
      <span class="text-slate-500 tabular-nums dark:text-slate-400">
        {{ pins.length }} {{ pins.length === 1 ? 'player' : 'players' }}
        <template v-if="!textureMode"> · grid view</template>
      </span>
    </figcaption>
  </figure>
</template>
