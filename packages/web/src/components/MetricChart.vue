<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { buildValueAxis } from '@palsentry/shared';
import { formatChartTime, formatChartTimestamp } from '@/lib/format';

interface ChartPoint {
  ts: number;
  value: number;
}

const props = withDefaults(
  defineProps<{
    points: ChartPoint[];
    label: string;
    /** CSS colour for the stroke, the sample dots, and the legend swatch. */
    colour: string;
    /** Human-readable description of the plotted span, used in the chart's accessible name. */
    rangeLabel: string;
    /** Appended to values in the legend and the hover readout, e.g. `fps` or ` ms`. */
    unit?: string;
    /**
     * Axis precision: `0` keeps gridlines on whole numbers for counts, `1` allows halves and
     * tenths for durations. Left unset it is inferred from the data.
     */
    decimals?: number;
    height?: number;
  }>(),
  { unit: '', decimals: undefined, height: 160 },
);

/**
 * Chart geometry in real pixels, measured from the container.
 *
 * An earlier version stretched a 0–100 viewBox with `preserveAspectRatio="none"`, which works for a
 * bare line but distorts anything with text in it. Axis labels and the hover readout need readable
 * type, so the SVG is now drawn at its natural size and a `ResizeObserver` feeds it the width.
 */
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 14;
/** Aim for roughly four horizontal gridlines; more than that crowds the plot. */
const Y_TICK_TARGET = 4;
/** Minimum gap between two x-axis labels before they start to collide. */
const X_TICK_GAP = 16;
/** Hard cap on x-axis labels, however wide the chart gets. */
const X_TICK_MAX = 6;
/** Series this short get a dot per sample, so individual buckets stay distinguishable. */
const SPARSE_DOT_LIMIT = 64;
/** Approximate advance width of the 10px axis font, used to reserve label space. */
const AXIS_CHAR_PX = 6.2;
/** Approximate height of the hover tooltip, used to decide whether it flips below the point. */
const TOOLTIP_HEIGHT = 46;

const container = ref<HTMLElement | null>(null);
const width = ref(0);
let observer: ResizeObserver | null = null;

onMounted(() => {
  const element = container.value;
  if (element === null) return;

  width.value = element.clientWidth;
  observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry !== undefined) width.value = entry.contentRect.width;
  });
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

const chart = computed(() => {
  const points = props.points;
  const measured = width.value;
  if (points.length === 0 || measured <= 0) return null;

  const axis = buildValueAxis(
    points.map((point) => point.value),
    { targetTicks: Y_TICK_TARGET, decimals: props.decimals },
  );
  if (axis === null) return null;

  const widestLabel = Math.max(...axis.ticks.map((tick) => tick.label.length));
  // The y-axis labels sit outside the plot, so the left pad grows with the widest value.
  const padLeft = Math.min(92, Math.max(34, 14 + widestLabel * AXIS_CHAR_PX));
  const plotWidth = Math.max(1, measured - padLeft - PAD_RIGHT);
  const plotHeight = Math.max(24, props.height - PAD_TOP - PAD_BOTTOM);
  const baseline = PAD_TOP + plotHeight;
  const span = axis.max - axis.min;

  const x = (index: number): number =>
    padLeft + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number): number =>
    PAD_TOP + plotHeight - ((value - axis.min) / span) * plotHeight;

  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`,
    )
    .join(' ');

  const last = points[points.length - 1];
  const first = points[0];

  return {
    axis,
    width: measured,
    height: props.height,
    padLeft,
    padRight: measured - PAD_RIGHT,
    plotTop: PAD_TOP,
    baseline,
    x,
    y,
    line,
    // Close the path down to the baseline so it can be filled as an area.
    area: `${line} L${x(points.length - 1).toFixed(2)},${baseline} L${x(0).toFixed(2)},${baseline} Z`,
    lastValue: last?.value ?? 0,
    lastTs: last?.ts ?? 0,
    firstTs: first?.ts ?? 0,
    /** Exact plotted span, so short and multi-day ranges get different timestamp labels. */
    spanSeconds: (last?.ts ?? 0) - (first?.ts ?? 0),
  };
});

const gradientId = computed(() => `chart-${props.label.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`);

const dataMin = computed(() => Math.min(...props.points.map((point) => point.value)));
const dataMax = computed(() => Math.max(...props.points.map((point) => point.value)));

const xTicks = computed(() => {
  const view = chart.value;
  const points = props.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (view === null || first === undefined || last === undefined) return [];

  // Date labels are long, so pick the tick count from how much room the widest one needs rather
  // than from a fixed number of gridlines.
  const widest = Math.max(
    ...[first.ts, first.ts + view.spanSeconds / 2, last.ts].map(
      (ts) => formatChartTime(ts, view.spanSeconds).length * AXIS_CHAR_PX,
    ),
  );
  // Edge labels are anchored outwards, so the first gap needs extra room to clear the second label.
  const plotWidth = view.padRight - view.padLeft;
  const slots = Math.min(
    X_TICK_MAX,
    Math.max(1, Math.floor(plotWidth / (widest * 1.5 + X_TICK_GAP)) + 1),
  );
  const count = Math.max(1, Math.min(slots, points.length));

  const indices = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    indices.add(count === 1 ? 0 : Math.round((index * (points.length - 1)) / (count - 1)));
  }

  const ordered = [...indices].sort((a, b) => a - b);
  return ordered.map((index, position) => ({
    index,
    x: view.x(index),
    label: formatChartTime(points[index]?.ts ?? 0, view.spanSeconds),
    anchor:
      ordered.length === 1
        ? 'middle'
        : position === 0
          ? 'start'
          : position === ordered.length - 1
            ? 'end'
            : 'middle',
  }));
});

/** Individual samples are worth showing while the series is short enough to read. */
const showDots = computed(() => props.points.length <= SPARSE_DOT_LIMIT);

const activeIndex = ref<number | null>(null);
const pinned = ref(false);

// A range change can leave the cursor pointing past the end of the new series.
watch(
  () => props.points.length,
  (length) => {
    if (activeIndex.value !== null && activeIndex.value >= length) activeIndex.value = null;
  },
);

const active = computed(() => {
  const view = chart.value;
  const index = activeIndex.value;
  if (view === null || index === null) return null;

  const point = props.points[index];
  if (point === undefined) return null;

  return {
    index,
    x: view.x(index),
    y: view.y(point.value),
    valueLabel: `${point.value}${props.unit}`,
    timeLabel: formatChartTimestamp(point.ts),
  };
});

const tooltip = computed(() => {
  const point = active.value;
  const view = chart.value;
  if (point === null || view === null) return null;

  // Keep the tooltip inside the card; half its width is reserved on each side.
  const half = 92;
  const left = Math.min(Math.max(point.x, half), Math.max(half, view.width - half));
  // Flip below the point when there is not enough room above it for the tooltip.
  const below = point.y < TOOLTIP_HEIGHT + 16;

  return {
    style: {
      left: `${left}px`,
      top: below ? `${point.y + 12}px` : `${point.y - 12}px`,
      transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
    },
  };
});

/** Index of the sample nearest the pointer, following x only — that is how line charts are read. */
function indexAt(clientX: number): number | null {
  const view = chart.value;
  const element = container.value;
  if (view === null || element === null) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return null;

  // Scale defensively: the viewBox is drawn at the measured width, but a resize can land between
  // the observer firing and the next render.
  const localX = ((clientX - rect.left) / rect.width) * view.width;
  const ratio = (localX - view.padLeft) / (view.padRight - view.padLeft);
  const clamped = Math.min(1, Math.max(0, ratio));

  return Math.round(clamped * (props.points.length - 1));
}

function clearActive(): void {
  activeIndex.value = null;
  pinned.value = false;
}

function onPointerMove(event: PointerEvent): void {
  // Touch drags are reserved for scrolling; a tap pins the readout instead.
  if (event.pointerType === 'touch') return;
  activeIndex.value = indexAt(event.clientX);
}

function onPointerDown(event: PointerEvent): void {
  const index = indexAt(event.clientX);
  if (index === null) return;
  activeIndex.value = index;
  // Touch pointers "leave" as soon as the finger lifts, so pin the readout for them.
  pinned.value = event.pointerType === 'touch';
}

function onPointerLeave(event: PointerEvent): void {
  if (pinned.value || event.pointerType === 'touch') return;
  activeIndex.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  const lastIndex = props.points.length - 1;
  if (lastIndex < 0) return;

  const current = activeIndex.value;
  let next: number;

  switch (event.key) {
    case 'ArrowLeft':
      next = current === null ? lastIndex : Math.max(0, current - 1);
      break;
    case 'ArrowRight':
      next = current === null ? lastIndex : Math.min(lastIndex, current + 1);
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = lastIndex;
      break;
    case 'Escape':
      event.preventDefault();
      clearActive();
      return;
    default:
      return;
  }

  event.preventDefault();
  activeIndex.value = next;
  pinned.value = true;
}

/** Tapping outside the chart dismisses a pinned readout on touch, where blur is not guaranteed. */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!pinned.value) return;
  const element = container.value;
  if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
  clearActive();
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true));

const accessibleLabel = computed(() => {
  const view = chart.value;
  if (view === null) return `${props.label} chart. No samples in ${props.rangeLabel}.`;

  const count = props.points.length;
  return (
    `${props.label} for ${props.rangeLabel}: ${count} sample${count === 1 ? '' : 's'}, ` +
    `${view.axis.ticks[0]?.label ?? ''} to ${view.axis.ticks[view.axis.ticks.length - 1]?.label ?? ''} on the value axis, ` +
    `${formatChartTimestamp(view.firstTs)} to ${formatChartTimestamp(view.lastTs)}. ` +
    `Lowest ${dataMin.value}${props.unit}, highest ${dataMax.value}${props.unit}, latest ${view.lastValue}${props.unit}.`
  );
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-baseline justify-between gap-2">
      <div class="flex items-center gap-2">
        <span
          class="h-2 w-2 rounded-full"
          :style="{ backgroundColor: colour }"
          aria-hidden="true"
        />
        <span class="text-xs font-medium text-slate-600 dark:text-slate-300">{{ label }}</span>
      </div>
      <div v-if="chart" class="text-xs text-slate-500 tabular-nums dark:text-slate-400">
        <span class="font-semibold text-slate-800 dark:text-slate-100">
          {{ chart.lastValue }}{{ unit }}
        </span>
        <span class="ml-2 opacity-70"> {{ dataMin }}{{ unit }}–{{ dataMax }}{{ unit }} </span>
      </div>
    </div>

    <!--
      The measuring element is always rendered, even before the first sample arrives: the chart
      geometry needs a width, so hiding this container would leave the ResizeObserver with nothing
      to measure and the chart would never appear.
    -->
    <div ref="container" class="relative" :style="{ height: `${height}px` }">
      <p
        v-if="chart === null"
        class="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400 dark:border-slate-700 dark:text-slate-500"
      >
        Waiting for the first sample…
      </p>

      <div
        v-else
        class="absolute inset-0 touch-pan-y"
        tabindex="0"
        role="img"
        :aria-label="accessibleLabel"
        @pointermove="onPointerMove"
        @pointerdown="onPointerDown"
        @pointerleave="onPointerLeave"
        @keydown="onKeydown"
        @blur="clearActive"
      >
        <svg
          :width="chart.width"
          :height="chart.height"
          :viewBox="`0 0 ${chart.width} ${chart.height}`"
          class="overflow-visible"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :stop-color="colour" stop-opacity="0.35" />
              <stop offset="100%" :stop-color="colour" stop-opacity="0" />
            </linearGradient>
          </defs>

          <!-- Value gridlines, so a height on the plot can be read as a number. -->
          <g class="stroke-slate-200 dark:stroke-slate-700/70">
            <line
              v-for="tick in chart.axis.ticks"
              :key="`y-${tick.value}`"
              :x1="chart.padLeft"
              :x2="chart.padRight"
              :y1="chart.y(tick.value)"
              :y2="chart.y(tick.value)"
              stroke-width="1"
              :stroke-dasharray="tick.value === chart.axis.min ? undefined : '3 3'"
            />
          </g>

          <!-- Time gridlines, one per labelled tick, so a position can be read as a date. -->
          <g class="stroke-slate-200 dark:stroke-slate-700/70">
            <line
              v-for="tick in xTicks"
              :key="`x-${tick.index}`"
              :x1="tick.x"
              :x2="tick.x"
              :y1="chart.plotTop"
              :y2="chart.baseline"
              stroke-width="1"
              stroke-dasharray="3 3"
            />
          </g>

          <path :d="chart.area" :fill="`url(#${gradientId})`" />

          <g v-if="showDots">
            <circle
              v-for="(point, index) in points"
              :key="`dot-${point.ts}`"
              :cx="chart.x(index)"
              :cy="chart.y(point.value)"
              r="2.5"
              :fill="colour"
              class="stroke-white dark:stroke-slate-900"
              stroke-width="1"
            />
          </g>

          <path
            :d="chart.line"
            fill="none"
            :stroke="colour"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />

          <!-- Axis labels are plain SVG text now that the viewBox matches the pixel size. -->
          <g class="fill-slate-400 text-[10px] tabular-nums dark:fill-slate-500" text-anchor="end">
            <text
              v-for="tick in chart.axis.ticks"
              :key="`yl-${tick.value}`"
              :x="chart.padLeft - 8"
              :y="chart.y(tick.value)"
              dy="0.32em"
            >
              {{ tick.label }}
            </text>
          </g>

          <g class="fill-slate-400 text-[10px] tabular-nums dark:fill-slate-500">
            <text
              v-for="tick in xTicks"
              :key="`xl-${tick.index}`"
              :x="tick.x"
              :y="chart.baseline + 14"
              :text-anchor="tick.anchor"
            >
              {{ tick.label }}
            </text>
          </g>

          <g v-if="active">
            <line
              :x1="active.x"
              :x2="active.x"
              :y1="chart.plotTop"
              :y2="chart.baseline"
              class="stroke-slate-400 dark:stroke-slate-400"
              stroke-width="1"
            />
            <circle
              :cx="active.x"
              :cy="active.y"
              r="4"
              :fill="colour"
              class="stroke-white dark:stroke-slate-900"
              stroke-width="2"
            />
          </g>
        </svg>

        <div
          v-if="active && tooltip"
          class="pointer-events-none absolute z-10 rounded-lg border border-slate-200 bg-white/95 px-2 py-1 text-[11px] whitespace-nowrap shadow-lg dark:border-slate-700 dark:bg-slate-900/95"
          :style="tooltip.style"
        >
          <p class="font-semibold text-slate-800 tabular-nums dark:text-slate-100">
            {{ active.valueLabel }}
          </p>
          <p class="text-slate-500 tabular-nums dark:text-slate-400">{{ active.timeLabel }}</p>
        </div>
      </div>

      <p class="sr-only" aria-live="polite">
        {{ active ? `${active.timeLabel}: ${active.valueLabel}` : '' }}
      </p>
    </div>
  </div>
</template>
