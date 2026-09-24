<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, Crosshair, History, LoaderCircle, MapPin, RefreshCw, X } from '@lucide/vue';
import {
  DEFAULT_WAYBACK_WINDOW,
  HISTORY_WINDOWS,
  minimumTimelineSpanSeconds,
  type BasesResponse,
  type HistorySelection,
  type HistoryWindow,
  type PalworldGuildBase,
  type TimeBounds,
  type TimeRange,
  type WaybackSnapshot,
} from '@palsentry/shared';
import { useServerStore } from '@/stores/server';
import { usePolling } from '@/composables/usePolling';
import { usePlayerHistory } from '@/composables/usePlayerHistory';
import { api, errorMessage } from '@/lib/api';
import { resolveMapMeta } from '@/lib/map-display';
// import { formatInterval } from '@/lib/format';
import { waybackMarkersAt } from '@/lib/wayback';
import EmptyState from '@/components/EmptyState.vue';
import OfflineBanner from '@/components/OfflineBanner.vue';
import HistoryRangeFilter from '@/components/HistoryRangeFilter.vue';
import WaybackTimeline from '@/components/WaybackTimeline.vue';
import WorldMap from '@/components/WorldMap.vue';

const BASE_POLL_MS = 15_000;
/** Never poll history faster than this, however fine the server's recording cadence is. */
const MIN_WAYBACK_POLL_MS = 15_000;
/** Assumed retention before `/meta` answers, for validating a hand-edited range in the URL. */
const ASSUMED_RETENTION_DAYS = 30;
const server = useServerStore();
const route = useRoute();
const router = useRouter();
const bases = ref<PalworldGuildBase[]>([]);
const basesResponse = ref<BasesResponse | null>(null);
const baseRetrying = ref(false);

// ---------------------------------------------------------------------------
// Wayback mode
// ---------------------------------------------------------------------------

/**
 * Whether the map is replaying recorded movement instead of showing the live world.
 *
 * Like live tracking, this lives in the URL: a wayback link carries the range and the chosen
 * instant, survives a reload, and works with browser back/forward. `wayback=1` is the single
 * source of truth, so the rest of the view can stay ignorant of how the mode was entered.
 */
const isWayback = computed(() => route.query.wayback === '1');

/** Query keys owned by wayback mode; cancelling removes exactly these. */
const WAYBACK_QUERY_KEYS = ['wayback', 'window', 'from', 'to', 'at'] as const;

function isHistoryWindow(value: string): value is HistoryWindow {
  return (HISTORY_WINDOWS as readonly string[]).includes(value);
}

/**
 * The requested range, taken from the URL and repaired if it is not usable.
 *
 * A hand-edited or stale link should show history rather than an error page, so anything that is
 * not a known preset, a pair of ordered Unix seconds, or a retention-bounded span falls back to
 * the default window.
 */
const waybackSelection = computed<HistorySelection>(() => {
  const window = route.query.window;
  if (typeof window === 'string' && isHistoryWindow(window)) return { kind: 'window', window };

  const from = Number(route.query.from);
  const to = Number(route.query.to);
  const retentionDays = server.meta?.history.retentionDays ?? ASSUMED_RETENTION_DAYS;
  const withinRetention = to - from <= retentionDays * 24 * 60 * 60;

  if (
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from > 0 &&
    to > from &&
    withinRetention
  ) {
    return { kind: 'range', from, to };
  }

  return { kind: 'window', window: DEFAULT_WAYBACK_WINDOW };
});

/**
 * The instant the operator pinned, in Unix seconds, or null while following the newest one.
 *
 * A pinned instant is what makes a wayback link reproducible: "show me 02:40 last night" is the
 * whole point of the view. An absent value means the live tail, which keeps advancing as new
 * snapshots are recorded.
 */
const committedAt = computed(() => {
  const value = Number(route.query.at);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
});

/** A timestamp the pointer is previewing, shown until it moves away. Never written to the URL. */
const previewAt = ref<number | null>(null);

const waybackPollMs = computed(() =>
  Math.max(server.waybackIntervalSeconds * 1_000, MIN_WAYBACK_POLL_MS),
);

const history = usePlayerHistory(waybackSelection, waybackPollMs, isWayback);

const snapshots = computed<WaybackSnapshot[]>(() => history.response.value?.snapshots ?? []);

/**
 * The observation closest to a requested instant.
 *
 * Snapshots are the only instants PalSentry actually heard from the game server, so every chosen
 * time is resolved to one of them: a timestamp that is merely near a snapshot would describe data
 * nobody collected.
 */
function snapToSnapshot(ts: number, candidates: readonly WaybackSnapshot[]): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const snapshot of candidates) {
    const distance = Math.abs(snapshot.ts - ts);
    // Ties keep the earlier observation, matching how the eye reads a horizontal timeline.
    if (distance < bestDistance) {
      best = snapshot.ts;
      bestDistance = distance;
    }
  }

  return best;
}

const newestSnapshot = computed(() => snapshots.value.at(-1)?.ts ?? null);

/** The pinned instant, resolved to a real observation. Null while following the live tail. */
const pinnedSnapshot = computed(() => {
  const requested = committedAt.value;
  if (requested === null) return null;
  return snapToSnapshot(requested, snapshots.value);
});

/** The instant the map is rendering: a hover preview, then the pin, then the live tail. */
const effectiveTime = computed(
  () => previewAt.value ?? pinnedSnapshot.value ?? newestSnapshot.value,
);
/** True when the view tracks the newest observation rather than one the operator chose. */
const followingLatest = computed(() => pinnedSnapshot.value === null);
/** True while the URL names a rolling preset; a custom range is a fixed slice of past data. */
const rollingWindow = computed(() => waybackSelection.value.kind === 'window');

/**
 * Write wayback state back to the URL.
 *
 * `undefined` removes a key; the mode flag, the range, and the pin are handled together because
 * they only make sense as a set.
 */
function updateWaybackQuery(
  changes: Partial<Record<(typeof WAYBACK_QUERY_KEYS)[number], string | undefined>>,
  options: { replace?: boolean } = {},
): void {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(route.query)) {
    if (typeof value === 'string') query[key] = value;
  }

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete query[key];
    else query[key] = value;
  }

  const navigation = { name: 'map', query };
  if (options.replace === false) void router.push(navigation);
  else void router.replace(navigation);
}

/** Enter replay from the live map while preserving any tracking target for Cancel to restore. */
function showWayback(): void {
  previewAt.value = null;
  updateWaybackQuery(
    {
      wayback: '1',
      window: DEFAULT_WAYBACK_WINDOW,
      from: undefined,
      to: undefined,
      at: undefined,
    },
    { replace: false },
  );
}

/**
 * Pin the map to an instant recorded in the URL, so a chosen time can be shared.
 *
 * `replace` is how playback commits: it moves the pin once a second, and a replay should leave one
 * history entry behind — where it started — rather than hundreds to back out of one at a time.
 */
function commitWaybackTime(ts: number, options: { replace?: boolean } = {}): void {
  previewAt.value = null;
  // Choosing the newest observation of a rolling window means "keep up with the server", not
  // "freeze here". Writing it down would leave the view pinned one interval behind the data with
  // nothing to say so. A fixed range cannot roll, so it always names the moment it replays.
  const follow = rollingWindow.value && ts === newestSnapshot.value;
  updateWaybackQuery(
    { at: follow ? undefined : String(ts) },
    { replace: options.replace ?? false },
  );
}

/** Change the range. The pinned instant does not survive: it belonged to the old range. */
function changeWaybackSelection(selection: HistorySelection): void {
  previewAt.value = null;
  updateWaybackQuery(
    selection.kind === 'window'
      ? { window: selection.window, from: undefined, to: undefined, at: undefined }
      : {
          window: undefined,
          from: String(selection.from),
          to: String(selection.to),
          at: undefined,
        },
  );
}

/**
 * Adopt a viewport the operator panned or zoomed to.
 *
 * The visible window is stored as an absolute range, because a rolling preset cannot describe a
 * window someone dragged: the first gesture resolves it. The pinned instant deliberately stays in
 * the URL — the response watcher moves it onto the nearest observation that is still in view, so
 * panning does not silently change which moment the map is showing.
 */
function changeWaybackViewport(range: TimeRange): void {
  previewAt.value = null;
  updateWaybackQuery({ window: undefined, from: String(range.from), to: String(range.to) });
}

/** Leave wayback mode, restoring the ordinary live map exactly as it was. */
function cancelWayback(): void {
  previewAt.value = null;
  updateWaybackQuery({
    wayback: undefined,
    window: undefined,
    from: undefined,
    to: undefined,
    at: undefined,
  });
}

/** The route query is the single source of truth for follow mode. */
const trackedUserId = computed(() => {
  // Wayback and live following are mutually exclusive: replaying history while the camera chases
  // a live player would show two different moments on one map.
  if (isWayback.value) return null;

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
const mapMeta = computed(() => resolveMapMeta(server.meta?.map));

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

/** Retention bound for the wayback range filter; mirrors the server's own limit. */
const retentionDays = computed(() => server.meta?.history.retentionDays ?? ASSUMED_RETENTION_DAYS);
const retentionSeconds = computed(() => Math.max(1, Math.floor(retentionDays.value)) * 86_400);

/** The loaded range, for the timeline's layout. */
const historyFrom = computed(() => history.response.value?.from ?? null);
const historyTo = computed(() => history.response.value?.to ?? null);

/**
 * The visible range.
 *
 * A custom selection *is* the viewport, so it comes straight from the URL: the timeline does not
 * wait for the matching response to draw the window the operator just panned to. A rolling preset
 * has no boundaries of its own, so it follows whatever the server resolved for it.
 */
const viewportFrom = computed(() =>
  waybackSelection.value.kind === 'range' ? waybackSelection.value.from : historyFrom.value,
);
const viewportTo = computed(() =>
  waybackSelection.value.kind === 'range' ? waybackSelection.value.to : historyTo.value,
);

/**
 * True while the drawn observations belong to a range the viewport has already left.
 *
 * Panning issues a request, and until it lands the previous range's snapshots are still in hand.
 * They are clipped to the new window and dimmed rather than passed off as this range's data.
 */
const historyStale = computed(() => {
  const response = history.response.value;
  if (response === null || viewportFrom.value === null || viewportTo.value === null) return false;
  return response.from !== viewportFrom.value || response.to !== viewportTo.value;
});

/** An answer with no observations is only "empty" once it describes the range being shown. */
const historyEmpty = computed(
  () => !historyStale.value && history.response.value !== null && snapshots.value.length === 0,
);

/**
 * Keep the committed instant honest as the range changes under it.
 *
 * Three repairs, all written with `replace` so they never become history entries the operator has
 * to back out of: a pin that lands between two observations is moved onto the nearer one, a pin on
 * the newest observation of a rolling window becomes "follow the tail" again — otherwise the view
 * would sit frozen one interval behind the data with no obvious way to resume — and a fixed range
 * that names no moment at all adopts the newest observation it contains, because only a rolling
 * window may mean "whatever is newest right now".
 */
watch([committedAt, snapshots], () => {
  // Stale snapshots belong to the range the operator has already left; repairing against them
  // would pin the new range to an instant it does not contain.
  if (historyStale.value) return;

  if (snapshots.value.length === 0) {
    // An empty range has nothing to replay, so a pin carried over from another range would name a
    // moment this range does not contain.
    if (historyEmpty.value && committedAt.value !== null) updateWaybackQuery({ at: undefined });
    return;
  }

  const newest = newestSnapshot.value;
  if (newest === null) return;
  const requested = committedAt.value;

  if (requested === null) {
    if (rollingWindow.value) return;
    updateWaybackQuery({ at: String(newest) });
    return;
  }

  const snapped = snapToSnapshot(requested, snapshots.value);
  if (snapped === null) return;

  if (snapped === newest && rollingWindow.value) {
    updateWaybackQuery({ at: undefined });
    return;
  }
  if (snapped !== requested) updateWaybackQuery({ at: String(snapped) });
});

/** The closest the timeline may zoom: two recording intervals, and never under a minute. */
const minimumWaybackSpan = computed(() =>
  minimumTimelineSpanSeconds(server.waybackIntervalSeconds),
);

/** The instants wayback may cover: retained history through the present. */
const waybackBounds = computed<TimeBounds>(() => {
  const to = Math.max(historyTo.value ?? 0, Math.floor(Date.now() / 1_000));
  return { from: to - retentionSeconds.value, to };
});

/** The players recorded at the shown instant, and where each of them was. */
const scene = computed(() =>
  waybackMarkersAt(history.response.value?.players ?? [], effectiveTime.value),
);

/**
 * Whether current guild bases are drawn on the historical map.
 *
 * Off by default and labelled as current wherever it is on: a base marker is a fact about now, and
 * the historical map has no way to tell whether that base existed at the moment being viewed.
 */
const showWaybackBases = ref(false);

/**
 * The same players the map is drawing, in name order.
 *
 * The map answers "where", this list answers "who" — and it lists exactly the accounts in the
 * selected observation, so the two can never disagree.
 */
const waybackRows = computed(() => [...scene.value].sort((a, b) => a.name.localeCompare(b.name)));
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">
          {{ isWayback ? 'Wayback map' : 'World map' }}
        </h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          <template v-if="isWayback">
            <History class="mr-1 inline h-3 w-3" aria-hidden="true" />
            Recorded positions for every player PalSentry has seen. Live pins and tracking are
            paused.
          </template>
          <template v-else>
            <MapPin class="mr-1 inline h-3 w-3" aria-hidden="true" />
            Live positions of online players, refreshed with the rest of the dashboard.
          </template>
        </p>
      </div>

      <button
        v-if="!isWayback"
        type="button"
        class="btn-secondary btn-xs"
        title="Replay recorded player movement"
        @click="showWayback"
      >
        <History class="h-3.5 w-3.5" aria-hidden="true" />
        Wayback map
      </button>
    </div>

    <section v-if="isWayback" class="card">
      <div class="card-header flex-wrap items-end gap-3">
        <div class="min-w-0">
          <h2 class="card-title">Replay</h2>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Drag to pan through time, scroll to zoom, and click or press an arrow key to hold a
            moment.
          </p>
        </div>

        <HistoryRangeFilter
          :model-value="waybackSelection"
          :retention-days="retentionDays"
          :default-custom-span-seconds="24 * 60 * 60"
          :seconds-precision="true"
          :bounds="waybackBounds"
          :minimum-span-seconds="minimumWaybackSpan"
          label="History range"
          class="ml-auto"
          @update:model-value="changeWaybackSelection"
        />

        <button type="button" class="btn-secondary btn-xs" @click="cancelWayback">
          <X class="h-3.5 w-3.5" aria-hidden="true" />
          Cancel Wayback map
        </button>
      </div>

      <div class="space-y-2 p-4 pt-3">
        <p
          v-if="history.error.value !== null"
          class="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
          role="alert"
        >
          {{ history.error.value }}
          <span v-if="historyStale">The timeline below is still the previous range.</span>
          <button type="button" class="ml-1 underline" @click="history.reload()">Retry</button>
        </p>

        <p
          v-if="history.loading.value"
          class="flex items-center justify-center gap-2 py-6 text-xs text-slate-500 dark:text-slate-400"
          role="status"
        >
          <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading recorded positions…
        </p>

        <!--
          The timeline stays mounted for an empty range: panning out of a gap is exactly what
          someone staring at "nothing was recorded" wants to do next.
        -->
        <template v-else-if="viewportFrom !== null && viewportTo !== null">
          <WaybackTimeline
            :snapshots="snapshots"
            :from="viewportFrom"
            :to="viewportTo"
            :value="pinnedSnapshot"
            :preview="previewAt"
            :retention-days="retentionDays"
            :interval-seconds="server.waybackIntervalSeconds"
            :bucket-seconds="history.response.value?.bucketSeconds ?? null"
            :rolling="rollingWindow"
            :class="historyStale ? 'opacity-40' : ''"
            @preview="previewAt = $event"
            @update:value="commitWaybackTime"
            @update:range="changeWaybackViewport"
          />

          <!--          <p-->
          <!--            v-if="history.refreshing.value && history.error.value === null"-->
          <!--            class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"-->
          <!--            role="status"-->
          <!--          >-->
          <!--            <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />-->
          <!--            {{ historyStale ? 'Loading this range…' : 'Refreshing…' }}-->
          <!--          </p>-->

          <!--          <p-->
          <!--            v-else-if="historyEmpty"-->
          <!--            class="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"-->
          <!--          >-->
          <!--            Nothing was recorded in this range. PalSentry records positions every-->
          <!--            {{ formatInterval(server.waybackIntervalSeconds) }} while it is running — a gap this-->
          <!--            long usually means it was not.-->
          <!--          </p>-->
        </template>
      </div>

      <div
        v-if="!historyEmpty && !history.loading.value && history.error.value === null"
        class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400"
      >
        <p>
          <template v-if="previewAt !== null">
            Previewing this moment — click to hold it, or move away to let go.
          </template>
          <template v-else-if="followingLatest">
            Following the newest observation as it is recorded.
          </template>
          <template v-else-if="rollingWindow">
            Holding one moment. Pick the newest column to follow again.
          </template>
          <template v-else>
            A fixed range. Pick a rolling window to follow the server again.
          </template>
          <span v-if="scene.length > 0">
            · {{ scene.length }} {{ scene.length === 1 ? 'player' : 'players' }} at this time
          </span>
        </p>

        <label class="flex items-center gap-2">
          <input v-model="showWaybackBases" type="checkbox" class="h-3.5 w-3.5" />
          Show current guild bases (not historical)
        </label>
      </div>
    </section>

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
          >— the map re-centers on each refresh and switches region if the player teleports. Pan and
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
      v-if="baseLoading && !isWayback"
      class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
      role="status"
    >
      <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
      Loading guild bases…
    </div>

    <div
      v-else-if="baseIssue && (!isWayback || showWaybackBases)"
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
        :players="isWayback ? [] : server.onlinePlayers"
        :bases="isWayback ? (showWaybackBases ? bases : []) : bases"
        :bases-available="basesResponse?.available === true"
        :online="server.online"
        :map="mapMeta"
        :tracked-user-id="trackedUserId"
        :wayback="isWayback && effectiveTime !== null ? scene : null"
      />
    </section>

    <section v-if="isWayback" class="card">
      <div class="card-header">
        <h2 class="card-title">Positions at this time</h2>
        <span class="text-xs text-slate-500 dark:text-slate-400">
          Exactly the players recorded at this moment.
        </span>
      </div>

      <EmptyState
        v-if="!history.loading.value && waybackRows.length === 0"
        title="Nobody was recorded then"
        :description="
          historyEmpty
            ? 'Nothing was recorded in the selected range.'
            : 'No player was online in the observation at this moment.'
        "
      />

      <div v-else class="overflow-x-auto p-4 pt-0">
        <table class="w-full border-collapse">
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800">
              <th scope="col" class="table-head">Player</th>
              <th scope="col" class="table-head text-right">X</th>
              <th scope="col" class="table-head text-right">Y</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="player in waybackRows"
              :key="player.userId"
              class="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
            >
              <td class="cell">
                <span
                  class="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                  :style="{ backgroundColor: player.colour }"
                  aria-hidden="true"
                />
                <span class="font-medium">{{ player.name }}</span>
              </td>
              <td class="cell text-right font-mono text-xs tabular-nums">
                {{ Math.round(player.position.x) }}
              </td>
              <td class="cell text-right font-mono text-xs tabular-nums">
                {{ Math.round(player.position.y) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else-if="server.onlinePlayers.length > 0" class="card">
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
