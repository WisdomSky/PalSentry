<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WaybackSnapshot } from '@palsentry/shared';
import { formatChartTime, formatChartTimestamp } from '@/lib/format';

/**
 * Wayback Machine-style datetime strip.
 *
 * Each column is one recorded observation, so the strip doubles as a picture of the server's
 * activity and as the only set of instants that can be selected: there is no meaningful answer for
 * a time between two observations, and pretending otherwise would put invented data on the map.
 *
 * Pointer movement previews (the parent shows that instant without touching the URL), leaving
 * reverts, and releasing the button — or pressing an arrow key — commits. The strip is a single
 * `role="slider"`, so keyboard and screen-reader users get the same control the mouse has instead
 * of a decorative graphic.
 */
const props = withDefaults(
  defineProps<{
    /** Successful observations in the loaded range, ascending. */
    snapshots: readonly WaybackSnapshot[];
    /** Inclusive range boundaries the strip is laid out across. */
    from: number;
    to: number;
    /** The committed instant, or null when the newest observation is being followed. */
    value: number | null;
    /**
     * An instant being previewed, shown ahead of `value` while the pointer is on the strip.
     *
     * The map follows this, so the strip does too — otherwise the playhead would sit on the
     * committed moment while the map showed a different one, and the two would disagree about
     * which instant is on screen.
     */
    preview?: number | null;
    /** Number of columns a Page key moves, for a strip too fine to step through one by one. */
    pageStep?: number;
  }>(),
  { pageStep: 10, preview: null },
);

const emit = defineEmits<{
  /** A committed instant. The parent owns what that means for the URL. */
  'update:value': [number];
  /** A hovered/dragged instant, or null when the pointer left the strip. */
  preview: [number | null];
}>();

const track = ref<HTMLElement | null>(null);

const span = computed(() => Math.max(1, props.to - props.from));
const maxPlayerCount = computed(() =>
  props.snapshots.reduce((peak, snapshot) => Math.max(peak, snapshot.playerCount), 0),
);

/** The instant on screen: the previewed one, then the committed one, then the newest. */
const effectiveTs = computed(
  () => props.preview ?? props.value ?? props.snapshots.at(-1)?.ts ?? null,
);

const selectedIndex = computed(() => {
  const ts = effectiveTs.value;
  if (ts === null) return 0;
  const index = props.snapshots.findIndex((snapshot) => snapshot.ts === ts);
  // A committed instant that has scrolled out of the range resolves to the newest column rather
  // than to a negative index, which would render the thumb off the strip.
  return index === -1 ? props.snapshots.length - 1 : index;
});

/** The local time zone, so a shared "02:40" is unambiguous. */
const timeZone = computed(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

function positionPercent(ts: number): number {
  return ((ts - props.from) / span.value) * 100;
}

/**
 * Column height, on a square-root scale.
 *
 * One popular hour should not flatten every quieter one to an invisible sliver, and the strip is
 * about *when* something happened rather than how many people were there.
 */
function barPercent(playerCount: number): number {
  if (playerCount <= 0) return 0;
  const peak = maxPlayerCount.value;
  if (peak <= 0) return 0;
  return Math.max(12, Math.sqrt(playerCount / peak) * 100);
}

/** Snap an arbitrary instant to the observation nearest to it. */
function nearestSnapshot(ts: number): WaybackSnapshot | null {
  let best: WaybackSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const snapshot of props.snapshots) {
    const distance = Math.abs(snapshot.ts - ts);
    // Ties keep the earlier observation, so a click between two columns does not jump forward.
    if (distance < bestDistance) {
      best = snapshot;
      bestDistance = distance;
    }
  }

  return best;
}

function snapshotAt(event: PointerEvent): WaybackSnapshot | null {
  const element = track.value;
  if (element === null || props.snapshots.length === 0) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return null;

  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  return nearestSnapshot(props.from + ratio * span.value);
}

function onPointerMove(event: PointerEvent): void {
  const snapshot = snapshotAt(event);
  emit('preview', snapshot === null ? null : snapshot.ts);
}

function onPointerLeave(): void {
  emit('preview', null);
}

/**
 * Commit on release rather than on click.
 *
 * A drag is the natural touch gesture, and a drag ends with a release that `click` would only
 * sometimes follow — so the release is what decides, for mouse and touch alike.
 */
function onPointerUp(event: PointerEvent): void {
  const snapshot = snapshotAt(event);
  if (snapshot === null) return;
  (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
  emit('update:value', snapshot.ts);
}

function commitIndex(index: number): void {
  const clamped = Math.min(Math.max(0, index), props.snapshots.length - 1);
  const snapshot = props.snapshots[clamped];
  if (snapshot === undefined) return;
  emit('update:value', snapshot.ts);
}

function onKeydown(event: KeyboardEvent): void {
  const page = Math.max(1, props.pageStep);
  const moves: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: page,
    PageUp: -page,
  };

  if (event.key === 'Home') {
    event.preventDefault();
    commitIndex(0);
    return;
  }
  if (event.key === 'End') {
    event.preventDefault();
    commitIndex(props.snapshots.length - 1);
    return;
  }

  const move = moves[event.key];
  if (move === undefined) return;
  event.preventDefault();
  commitIndex(selectedIndex.value + move);
}

/** What a screen reader announces for the current position. */
const valueText = computed(() => {
  const ts = effectiveTs.value;
  if (ts === null) return 'No recorded observations';
  const snapshot = props.snapshots[selectedIndex.value];
  const players = snapshot?.playerCount ?? 0;
  const time = formatChartTimestamp(ts);
  const state = players === 0 ? 'nobody online' : `${players} online`;
  const following = props.preview === null && props.value === null;
  return following ? `${time}, ${state}, latest` : `${time}, ${state}`;
});
</script>

<template>
  <div class="select-none">
    <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
      <p class="text-[10px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Recorded movement
      </p>
      <p
        v-if="effectiveTs !== null"
        class="font-mono text-xs text-slate-700 tabular-nums dark:text-slate-200"
      >
        {{ formatChartTimestamp(effectiveTs) }}
        <span
          v-if="preview === null && value === null"
          class="ml-1 badge bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300"
        >
          latest
        </span>
      </p>
    </div>

    <!-- The strip itself: one column per observation, plus the playhead. -->
    <div
      ref="track"
      role="slider"
      tabindex="0"
      aria-label="Recorded player positions over time"
      aria-orientation="horizontal"
      :aria-valuemin="0"
      :aria-valuemax="Math.max(0, snapshots.length - 1)"
      :aria-valuenow="selectedIndex"
      :aria-valuetext="valueText"
      class="relative h-12 w-full cursor-crosshair touch-none rounded-md border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @pointerup="onPointerUp"
      @keydown="onKeydown"
    >
      <!-- Activity columns. A zero-player observation still gets a stub: it is real data. -->
      <div
        v-for="snapshot in snapshots"
        :key="snapshot.ts"
        class="absolute bottom-0 w-[3px] -translate-x-1/2 rounded-t-sm"
        :class="
          snapshot.playerCount === 0
            ? 'bg-slate-300 dark:bg-slate-700'
            : snapshot.ts <= (effectiveTs ?? 0)
              ? 'bg-teal-500/80 dark:bg-teal-400/70'
              : 'bg-slate-400/70 dark:bg-slate-600'
        "
        :style="{
          left: `${positionPercent(snapshot.ts)}%`,
          height: snapshot.playerCount === 0 ? '3px' : `${barPercent(snapshot.playerCount)}%`,
        }"
        :title="`${formatChartTimestamp(snapshot.ts)} — ${snapshot.playerCount} online`"
      ></div>

      <!-- Playhead. -->
      <div
        v-if="effectiveTs !== null"
        class="pointer-events-none absolute inset-y-0 w-px bg-teal-600 dark:bg-teal-400"
        :style="{ left: `${positionPercent(effectiveTs)}%` }"
        aria-hidden="true"
      >
        <span
          class="absolute top-0 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-teal-600 dark:bg-teal-400"
        ></span>
      </div>
    </div>

    <div class="mt-1 flex justify-between font-mono text-[10px] text-slate-500 dark:text-slate-400">
      <span>{{ formatChartTime(from, span) }}</span>
      <span title="Times are shown in this browser's time zone">local · {{ timeZone }}</span>
      <span>{{ formatChartTime(to, span) }}</span>
    </div>
  </div>
</template>
