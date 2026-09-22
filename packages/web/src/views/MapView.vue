<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, Crosshair, LoaderCircle, MapPin, RefreshCw, X } from '@lucide/vue';
import {
  DEFAULT_MAP_PROJECTION,
  DEFAULT_MAP_TEXTURE_URL,
  DEFAULT_WORLD_TREE_TEXTURE_URL,
  type BasesResponse,
  type PalworldGuildBase,
} from '@palsentry/shared';
import { useServerStore } from '@/stores/server';
import { usePolling } from '@/composables/usePolling';
import { api, errorMessage } from '@/lib/api';
import OfflineBanner from '@/components/OfflineBanner.vue';
import WorldMap from '@/components/WorldMap.vue';

const BASE_POLL_MS = 15_000;
const server = useServerStore();
const route = useRoute();
const router = useRouter();
const bases = ref<PalworldGuildBase[]>([]);
const basesResponse = ref<BasesResponse | null>(null);
const baseRetrying = ref(false);

/**
 * The route query is the single source of truth for follow mode.
 *
 * Keeping it in the URL (rather than component state) makes tracking deep-linkable, survives a
 * reload, and behaves correctly with browser back/forward.
 */
const trackedUserId = computed(() => {
  const value = route.query.track;
  return typeof value === 'string' && value !== '' ? value : null;
});
const trackedPlayer = computed(
  () => server.onlinePlayers.find((player) => player.userId === trackedUserId.value) ?? null,
);
const trackingNotice = ref<string | null>(null);

function stopTracking(notice: string | null = null): void {
  trackingNotice.value = notice;
  if (trackedUserId.value === null) return;
  const query = { ...route.query };
  delete query.track;
  // A replace, not a push: cancelling should not add a history entry the operator has to back out of.
  void router.replace({ name: 'map', query });
}

// The roster keeps players after they leave, so "absent from the list" only means they are offline
// when the list itself came from a successful read. An unreachable game server reports the whole
// roster as offline, and treating that as a disconnect would drop tracking during a restart.
watch(
  () => [trackedUserId.value, server.playerSnapshotAvailable, server.onlinePlayers.length] as const,
  () => {
    const id = trackedUserId.value;
    if (id === null || !server.playerSnapshotAvailable) return;
    if (server.onlinePlayers.some((player) => player.userId === id)) return;
    stopTracking('Tracking stopped: that player is no longer online.');
  },
);

watch(trackedUserId, (id) => {
  if (id !== null) trackingNotice.value = null;
});

// Mirrors the server defaults so the map renders correctly even before `/meta` lands.
const mapMeta = computed(
  () =>
    server.meta?.map ?? {
      projection: DEFAULT_MAP_PROJECTION,
      layers: {
        palpagos: { textureUrl: DEFAULT_MAP_TEXTURE_URL },
        worldTree: { textureUrl: DEFAULT_WORLD_TREE_TEXTURE_URL },
      },
    },
);

function applyBases(response: BasesResponse): void {
  basesResponse.value = response;
  // A transient failure should not make every known marker disappear. A valid empty snapshot does.
  if (response.available) bases.value = response.bases;
}

async function loadBases(refresh = false): Promise<void> {
  applyBases(await api.bases(refresh));
}

const basePolling = usePolling(() => loadBases(), { intervalMs: BASE_POLL_MS });

const baseIssue = computed(() => {
  if (basePolling.error.value !== null) return errorMessage(basePolling.error.value);
  return basesResponse.value?.available === false
    ? (basesResponse.value.error?.message ?? 'Guild bases are temporarily unavailable.')
    : null;
});
const basesStale = computed(() => baseIssue.value !== null && bases.value.length > 0);
const baseLoading = computed(
  () => basesResponse.value === null && basePolling.refreshing.value && baseIssue.value === null,
);

async function retryBases(): Promise<void> {
  if (baseRetrying.value) return;
  baseRetrying.value = true;
  try {
    await loadBases(true);
    basePolling.error.value = null;
  } catch (cause) {
    basePolling.error.value = cause;
  } finally {
    baseRetrying.value = false;
  }
}

async function refreshMap(): Promise<void> {
  await Promise.all([server.refreshNow(), retryBases()]);
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-lg font-semibold tracking-tight">World map</h1>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        <MapPin class="mr-1 inline h-3 w-3" aria-hidden="true" />
        Live positions of online players, refreshed with the rest of the dashboard.
      </p>
    </div>

    <OfflineBanner
      v-if="server.status !== null && !server.online"
      :message="server.status.error?.message ?? 'The Palworld server did not respond.'"
      @retry="refreshMap()"
    />

    <div
      v-if="trackedUserId !== null"
      class="flex flex-wrap items-center gap-2 rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-xs text-teal-900 dark:border-teal-900/70 dark:bg-teal-950/40 dark:text-teal-100"
      role="status"
      aria-live="polite"
    >
      <Crosshair class="h-4 w-4 shrink-0 animate-pulse" aria-hidden="true" />
      <p class="min-w-0">
        Tracking <span class="font-semibold">{{ trackedPlayer?.name ?? trackedUserId }}</span>
        <span class="opacity-75"
          >— the map recentres on each refresh and switches region if the player teleports. Pan and
          zoom stay available.</span
        >
      </p>
      <button type="button" class="btn-secondary btn-xs ml-auto shrink-0" @click="stopTracking()">
        <X class="h-3.5 w-3.5" aria-hidden="true" />
        Stop tracking
      </button>
    </div>

    <div
      v-else-if="trackingNotice"
      class="flex flex-wrap items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      role="status"
    >
      <Crosshair class="h-4 w-4 shrink-0" aria-hidden="true" />
      <p class="min-w-0">{{ trackingNotice }}</p>
      <button
        type="button"
        class="btn-ghost btn-xs ml-auto shrink-0"
        @click="trackingNotice = null"
      >
        Dismiss
      </button>
    </div>

    <div
      v-if="baseLoading"
      class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
      role="status"
    >
      <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
      Loading guild bases…
    </div>

    <div
      v-else-if="baseIssue"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200"
      role="alert"
    >
      <div class="flex min-w-0 items-start gap-2">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          {{ baseIssue }}
          <span v-if="basesStale" class="font-medium">
            Showing {{ bases.length }} last known {{ bases.length === 1 ? 'base' : 'bases' }}.
          </span>
        </p>
      </div>
      <button
        type="button"
        class="btn-secondary btn-xs"
        :disabled="baseRetrying"
        @click="retryBases"
      >
        <RefreshCw
          class="h-3.5 w-3.5"
          :class="{ 'animate-spin': baseRetrying }"
          aria-hidden="true"
        />
        Retry bases
      </button>
    </div>

    <section class="card p-4">
      <WorldMap
        :players="server.onlinePlayers"
        :bases="bases"
        :bases-available="basesResponse?.available === true"
        :online="server.online"
        :map="mapMeta"
        :tracked-user-id="trackedUserId"
      />
    </section>

    <section v-if="server.onlinePlayers.length > 0" class="card">
      <div class="card-header">
        <h2 class="card-title">Positions</h2>
      </div>
      <div class="overflow-x-auto p-4 pt-0">
        <table class="w-full border-collapse">
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800">
              <th scope="col" class="table-head">Player</th>
              <th scope="col" class="table-head text-right">X</th>
              <th scope="col" class="table-head text-right">Y</th>
              <th scope="col" class="table-head text-right">Level</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="player in server.onlinePlayers"
              :key="player.userId"
              class="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
              :class="player.userId === trackedUserId ? 'bg-teal-50/70 dark:bg-teal-950/30' : ''"
            >
              <td class="cell">
                <span class="font-medium">{{ player.name }}</span>
                <span
                  v-if="player.userId === trackedUserId"
                  class="badge ml-2 bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300"
                >
                  Tracking
                </span>
                <span
                  v-if="player.banned"
                  class="badge ml-2 bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                >
                  Banned
                </span>
              </td>
              <td class="cell text-right font-mono text-xs tabular-nums">
                {{ Math.round(player.location_x) }}
              </td>
              <td class="cell text-right font-mono text-xs tabular-nums">
                {{ Math.round(player.location_y) }}
              </td>
              <td class="cell text-right tabular-nums">{{ player.level }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
