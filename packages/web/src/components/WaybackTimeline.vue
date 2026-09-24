<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import {
  minimumTimelineSpanSeconds,
  nearestTimestamp,
  panTimelineRange,
  timelineFractionAt,
  timelineSpan,
  timelineTimeAt,
  zoomTimelineRangeAt,
  type TimeBounds,
  type TimeRange,
  type WaybackSnapshot,
} from '@palsentry/shared';
import { formatChartTime, formatChartTimestamp, formatInterval } from '@/lib/format';

/**
 * Wayback Machine-style datetime strip with an editor-style time camera.
 *
 * Each column is one recorded observation, so the strip doubles as a picture of the server's
 * activity and as the only set of instants that can be selected: there is no meaningful answer for
 * a time between two observations, and pretending otherwise would put invented data on the map.
 *
 * The strip shows the *viewport* — `from`/`to` are the instants at its edges, exactly like the
 * map's camera. Dragging empty space, or a horizontal wheel, pans it; pinch or Ctrl/Cmd+wheel zooms
 * around the pointer; a tap or a drag of the playhead selects an observation. Gestures update the
 * viewport immediately and emit `update:range` once they settle, so the parent can load that exact
 * range from the server while the strip stays responsive.
 *
 * The strip is a single `role="slider"` with the arrow/Home/End keys moving the playhead and
 * Shift+arrows plus the zoom buttons driving the viewport, so keyboard and screen-reader users get
 * the same control the mouse has instead of a decorative graphic.
 */
const props = withDefaults(
  defineProps<{
    /** Successful observations in the loaded range, ascending. */
    snapshots: readonly WaybackSnapshot[];
    /** Inclusive left edge of the visible range. */
    from: number;
    /** Inclusive right edge of the visible range. */
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
    /** Days of recorded history the server keeps: the far edge of panning and the widest zoom. */
    retentionDays: number;
    /** Recording cadence, which decides how close the timeline is allowed to zoom. */
    intervalSeconds: number;
  }>(),
  { pageStep: 10, preview: null },
);

const emit = defineEmits<{
  /** A committed instant. The parent owns what that means for the URL. */
  'update:value': [number];
  /** A hovered/dragged instant, or null when the pointer left the strip. */
  preview: [number | null];
  /** A settled viewport, ready to become the range the parent loads. */
  'update:range': [TimeRange];
}>();

/** Pointer travel that turns a click into a pan, in pixels. */
const PAN_THRESHOLD_PX = 4;
/** Wheel gestures have no release, so they commit once they stop arriving. */
const WHEEL_COMMIT_MS = 200;
/** One wheel notch (~100px) changes the span by about 1.28x, near the 1.5x button step. */
const WHEEL_ZOOM_SENSITIVITY = 0.0025;
/** Wheel deltas are pixels, lines or pages depending on the device; a notch is ~100px of travel. */
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 300;
const ZOOM_STEP = 1.5;
/** Shift+arrow pans by a quarter of the visible span, a readable step without losing the place. */
const KEYBOARD_PAN_FRACTION = 0.25;

const track = ref<HTMLElement | null>(null);
const helpId = useId();

/**
 * The range a gesture has produced, shown while the parent's committed range catches up.
 *
 * Cleared as soon as the parent's props arrive, so the URL stays the single source of truth: the
 * strip is never showing a viewport the rest of the app disagrees with.
 */
const localRange = ref<TimeRange | null>(null);
const dragging = ref(false);
/** True while a gesture or a pending wheel commit owns the viewport. */
const interacting = ref(false);

/** Live pointers' horizontal positions, for the one- and two-finger paths alike. */
const pointers = new Map<number, number>();
let gesture: {
  pointerId: number;
  startX: number;
  startRange: TimeRange;
  /** A press starts as a tap; travelling past the threshold turns it into a pan. */
  mode: 'tap' | 'pan';
} | null = null;
let pinch: { distance: number; midpoint: number; range: TimeRange } | null = null;
let commitTimer: number | null = null;

const baseRange = computed<TimeRange>(() => ({ from: props.from, to: props.to }));
const range = computed<TimeRange>(() => localRange.value ?? baseRange.value);
const span = computed(() => Math.max(1, timelineSpan(range.value)));
const minSpan = computed(() => minimumTimelineSpanSeconds(props.intervalSeconds));
const maxSpan = computed(() =>
  Math.max(minSpan.value, Math.round(Math.max(0, props.retentionDays) * 86_400)),
);
/** Seconds are worth showing once a minute holds more than one observation's worth of pixels. */
const dense = computed(() => span.value < 3_600);

const canZoomIn = computed(() => span.value > minSpan.value);
const canZoomOut = computed(() => span.value < maxSpan.value);

/** The instants a viewport may cover: retained history through the present. */
function boundsNow(): TimeBounds {
  const now = Math.floor(Date.now() / 1_000);
  return { from: now - maxSpan.value, to: now };
}

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

const snapshotTimes = computed(() => props.snapshots.map((snapshot) => snapshot.ts));

/** The local time zone, so a shared "02:40" is unambiguous. */
const timeZone = computed(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

function positionPercent(ts: number): number {
  return ((ts - range.value.from) / span.value) * 100;
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

/** The observation nearest an instant, or null when there is nothing to snap to. */
function nearestSnapshot(ts: number): WaybackSnapshot | null {
  const nearest = nearestTimestamp(snapshotTimes.value, ts);
  if (nearest === null) return null;
  return props.snapshots.find((snapshot) => snapshot.ts === nearest) ?? null;
}

/** Where a client x sits across the track: 0 at the left edge, 1 at the right. */
function fractionAt(clientX: number): number | null {
  const element = track.value;
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/** The observation under a client x, snapped to real recorded data. */
function snapshotAtClientX(clientX: number): WaybackSnapshot | null {
  const fraction = fractionAt(clientX);
  if (fraction === null) return null;
  return nearestSnapshot(timelineTimeAt(range.value, fraction));
}

/** True when the two edges of the viewport fall on different local days. */
const crossesDateBoundary = computed(() => {
  const from = new Date(range.value.from * 1000);
  const to = new Date(range.value.to * 1000);
  return (
    from.getFullYear() !== to.getFullYear() ||
    from.getMonth() !== to.getMonth() ||
    from.getDate() !== to.getDate()
  );
});

/** Axis edges name a whole day when they cross one, so a 24-hour view is not `12:03` twice. */
const axisOptions = computed(() => ({ seconds: dense.value, date: crossesDateBoundary.value }));

function setRange(next: TimeRange): void {
  localRange.value = next;
}

/** Tell the parent about the settled viewport; it decides how that becomes a loaded range. */
function commitRange(): void {
  const next = localRange.value;
  if (next === null) return;
  if (next.from === props.from && next.to === props.to) return;
  emit('update:range', { ...next });
}

function clearCommitTimer(): void {
  if (commitTimer === null) return;
  window.clearTimeout(commitTimer);
  commitTimer = null;
}

function scheduleCommit(): void {
  clearCommitTimer();
  commitTimer = window.setTimeout(() => {
    commitTimer = null;
    interacting.value = false;
    commitRange();
  }, WHEEL_COMMIT_MS);
}

/** End every in-flight gesture and settle the viewport, whichever input produced it. */
function finishGesture(): void {
  gesture = null;
  pinch = null;
  pointers.clear();
  dragging.value = false;
  interacting.value = false;
  clearCommitTimer();
  commitRange();
}

function zoomBy(factor: number): void {
  const anchor = playheadFraction() ?? 0.5;
  setRange(
    zoomTimelineRangeAt(range.value, span.value * factor, anchor, boundsNow(), minSpan.value),
  );
  commitRange();
}

/** Where the playhead sits across the track, or null when nothing is selected. */
function playheadFraction(): number | null {
  return effectiveTs.value === null ? null : timelineFractionAt(range.value, effectiveTs.value);
}

function startPinch(): void {
  const [first, second] = [...pointers.values()];
  if (first === undefined || second === undefined) return;
  pinch = {
    distance: Math.abs(second - first),
    midpoint: (first + second) / 2,
    range: range.value,
  };
}

function updatePinch(): void {
  const current = pinch;
  if (current === null) return;
  const [first, second] = [...pointers.values()];
  if (first === undefined || second === undefined) return;

  const rect = track.value?.getBoundingClientRect();
  if (rect === undefined || rect.width <= 0) return;

  const distance = Math.abs(second - first);
  const midpoint = (first + second) / 2;
  if (current.distance <= 0 || distance <= 0) return;

  const anchor = Math.min(1, Math.max(0, (midpoint - rect.left) / rect.width));
  const zoomed = zoomTimelineRangeAt(
    current.range,
    timelineSpan(current.range) * (current.distance / distance),
    anchor,
    boundsNow(),
    minSpan.value,
  );
  // The midpoint travels as well as spreads, so a two-finger drag pans while it zooms.
  const travelled = ((midpoint - current.midpoint) / rect.width) * timelineSpan(zoomed);
  setRange(panTimelineRange(zoomed, travelled, boundsNow(), minSpan.value));
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, event.clientX);
  dragging.value = true;
  interacting.value = true;
  clearCommitTimer();
  // preventDefault keeps the drag from starting a text selection; focus is restored by hand so the
  // slider still takes arrow keys after a click, the way tabbing to it does.
  element.focus({ preventScroll: true });
  event.preventDefault();

  if (pointers.size >= 2) {
    // A second finger abandons the drag and starts a pinch from where the view is now.
    gesture = null;
    startPinch();
    return;
  }

  // Every press is pan-eligible: the release decides whether it was a drag or a click, so a press
  // never has to guess whether it landed on the playhead. The hover preview parks that line under
  // the pointer, which is exactly what made a strip full of observations impossible to pan.
  gesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startRange: range.value,
    mode: 'tap',
  };
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) {
    // Hovering previews without touching the committed value or the URL.
    const snapshot = snapshotAtClientX(event.clientX);
    emit('preview', snapshot === null ? null : snapshot.ts);
    return;
  }

  pointers.set(event.pointerId, event.clientX);

  if (pinch !== null && pointers.size >= 2) {
    updatePinch();
    event.preventDefault();
    return;
  }

  const active = gesture;
  if (active === null || active.pointerId !== event.pointerId) return;

  const travelled = event.clientX - active.startX;
  if (active.mode === 'tap' && Math.abs(travelled) > PAN_THRESHOLD_PX) {
    // Past the threshold this is a pan, not a click: pan, and drop the preview so the map stops
    // following a moment the operator is no longer pointing at.
    active.mode = 'pan';
    emit('preview', null);
  }

  if (active.mode === 'pan') {
    const width = track.value?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const delta = (-travelled / width) * timelineSpan(active.startRange);
    setRange(panTimelineRange(active.startRange, delta, boundsNow(), minSpan.value));
  } else {
    const snapshot = snapshotAtClientX(event.clientX);
    emit('preview', snapshot === null ? null : snapshot.ts);
  }

  event.preventDefault();
}

function onPointerUp(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);

  const wasPinching = pinch !== null;
  pinch = null;
  const active = gesture;
  gesture = null;
  const last = pointers.size === 0;
  dragging.value = !last;

  // A pinch that lost a finger keeps its range and waits for the remaining finger to lift; the
  // half-finished gesture is not something a single finger can continue.
  if (wasPinching || active === null || active.pointerId !== event.pointerId) {
    if (last) finishGesture();
    return;
  }

  if (active.mode === 'pan') {
    if (last) finishGesture();
    return;
  }

  // A tap: the release commits the observation under the pointer. A pan returned above.
  const snapshot = snapshotAtClientX(event.clientX);
  if (last) finishGesture();
  if (snapshot !== null) emit('update:value', snapshot.ts);
}

function onPointerLeave(): void {
  if (dragging.value) return;
  emit('preview', null);
}

function onWheel(event: WheelEvent): void {
  const rect = track.value?.getBoundingClientRect();
  if (rect === undefined || rect.width <= 0) return;

  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? WHEEL_PAGE_PX
        : 1;
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  // Ctrl/Cmd is the browser's own zoom, so it always zooms. Shift and a sideways trackpad swipe
  // are the horizontal-scroll gestures, which mean "move through time" on a timeline.
  const horizontal =
    !event.ctrlKey &&
    !event.metaKey &&
    (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY));

  if (horizontal) {
    const delta = (event.deltaX !== 0 ? event.deltaX : event.deltaY) * unit;
    setRange(
      panTimelineRange(range.value, (delta / rect.width) * span.value, boundsNow(), minSpan.value),
    );
  } else {
    // The wheel is the zoom while the cursor is on the strip, and the strip keeps it: the page
    // underneath stays put. Scrolling up (negative delta) magnifies, matching the zoom-in button
    // and the map, because here the span — not the camera scale — is the zoom level.
    const factor = Math.exp(event.deltaY * unit * WHEEL_ZOOM_SENSITIVITY);
    setRange(
      zoomTimelineRangeAt(range.value, span.value * factor, fraction, boundsNow(), minSpan.value),
    );
  }

  interacting.value = true;
  scheduleCommit();
  event.preventDefault();
}

function commitIndex(index: number): void {
  const clamped = Math.min(Math.max(0, index), props.snapshots.length - 1);
  const snapshot = props.snapshots[clamped];
  if (snapshot === undefined) return;
  emit('update:value', snapshot.ts);
}

function panByFraction(fraction: number): void {
  setRange(panTimelineRange(range.value, span.value * fraction, boundsNow(), minSpan.value));
  commitRange();
}

function onKeydown(event: KeyboardEvent): void {
  const page = Math.max(1, props.pageStep);

  if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    panByFraction(event.key === 'ArrowLeft' ? -KEYBOARD_PAN_FRACTION : KEYBOARD_PAN_FRACTION);
    return;
  }

  switch (event.key) {
    case '+':
    case '=':
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
      return;
    case '-':
    case '_':
      event.preventDefault();
      zoomBy(ZOOM_STEP);
      return;
    case 'Home':
      event.preventDefault();
      commitIndex(0);
      return;
    case 'End':
      event.preventDefault();
      commitIndex(props.snapshots.length - 1);
      return;
  }

  const moves: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: page,
    PageUp: -page,
  };
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
  const time = formatChartTimestamp(ts, { seconds: true });
  const state = players === 0 ? 'nobody online' : `${players} online`;
  const following = props.preview === null && props.value === null;
  return following ? `${time}, ${state}, latest` : `${time}, ${state}`;
});

/** The instant on screen, with seconds: it names one observation, not a minute of them. */
const effectiveLabel = computed(() =>
  effectiveTs.value === null ? null : formatChartTimestamp(effectiveTs.value, { seconds: true }),
);

/**
 * Adopt the parent's range once it arrives.
 *
 * A gesture in flight keeps its own baseline: a rolling preset's props move with every poll, and
 * letting one land mid-drag would yank the viewport back under the operator's finger.
 */
watch(
  () => [props.from, props.to] as const,
  () => {
    if (interacting.value) return;
    localRange.value = null;
  },
);

onBeforeUnmount(clearCommitTimer);
</script>

<template>
  <div class="select-none">
    <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
      <p class="text-[10px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Recorded movement
      </p>
      <p
        v-if="effectiveLabel !== null"
        class="font-mono text-xs text-slate-700 tabular-nums dark:text-slate-200"
      >
        {{ effectiveLabel }}
        <span
          v-if="preview === null && value === null"
          class="ml-1 badge bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300"
        >
          latest
        </span>
      </p>
    </div>

    <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="btn-secondary btn-xs px-1.5"
          :disabled="!canZoomIn"
          title="Zoom in"
          aria-label="Zoom in"
          @click="zoomBy(1 / ZOOM_STEP)"
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          class="btn-secondary btn-xs px-1.5"
          :disabled="!canZoomOut"
          title="Zoom out"
          aria-label="Zoom out"
          @click="zoomBy(ZOOM_STEP)"
        >
          <span aria-hidden="true">−</span>
        </button>
      </div>
      <p class="font-mono text-[10px] text-slate-500 tabular-nums dark:text-slate-400">
        {{ formatInterval(span) }} shown · {{ snapshots.length }}
        {{ snapshots.length === 1 ? 'observation' : 'observations' }}
      </p>
    </div>

    <p :id="helpId" class="sr-only">
      Drag to pan through time, scroll to zoom, and click to select a recorded moment. Shift and the
      arrow keys pan, and plus and minus zoom.
    </p>

    <!-- The strip itself: one column per observation, plus the playhead. -->
    <div
      ref="track"
      role="slider"
      tabindex="0"
      aria-label="Recorded player positions over time"
      aria-orientation="horizontal"
      :aria-describedby="helpId"
      :aria-valuemin="0"
      :aria-valuemax="Math.max(0, snapshots.length - 1)"
      :aria-valuenow="selectedIndex"
      :aria-valuetext="valueText"
      class="relative h-12 w-full touch-none overflow-hidden rounded-md border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
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
        :title="`${formatChartTimestamp(snapshot.ts, { seconds: true })} — ${snapshot.playerCount} online`"
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
      <span>{{ formatChartTime(range.from, span, axisOptions) }}</span>
      <span title="Times are shown in this browser's time zone">local · {{ timeZone }}</span>
      <span>{{ formatChartTime(range.to, span, axisOptions) }}</span>
    </div>
  </div>
</template>
