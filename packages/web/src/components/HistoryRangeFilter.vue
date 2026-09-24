<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  HISTORY_WINDOWS,
  clampTimelineRange,
  type HistorySelection,
  type HistoryWindow,
  type TimeBounds,
} from '@palsentry/shared';
import { formatInterval, localInputToUnixSeconds, unixSecondsToLocalInput } from '@/lib/format';

const props = withDefaults(
  defineProps<{
    modelValue: HistorySelection;
    /** Days of history the server keeps; bounds a custom range and its validation message. */
    retentionDays: number;
    label?: string;
    /**
     * Where a freshly chosen custom range starts, in seconds before now.
     *
     * The metric charts want a handful of samples (`6h`), while the wayback map wants a whole
     * session's worth to scrub through (`24h`), and both should open on something familiar.
     */
    defaultCustomSpanSeconds?: number;
    /**
     * Show seconds in the date inputs.
     *
     * The wayback timeline is panned and zoomed to arbitrary seconds, so its range has to survive
     * the trip through these inputs unchanged — at minute precision every gesture would leave the
     * field looking edited.
     */
    secondsPrecision?: boolean;
    /** Retained-history bounds; a range is fitted into them before it is emitted. */
    bounds?: TimeBounds | null;
    /** Shortest custom range the caller can render, in seconds. */
    minimumSpanSeconds?: number;
  }>(),
  {
    label: 'Range',
    defaultCustomSpanSeconds: 6 * 60 * 60,
    secondsPrecision: false,
    bounds: null,
    minimumSpanSeconds: 1,
  },
);

const emit = defineEmits<{ 'update:modelValue': [HistorySelection] }>();

const SECONDS_PER_DAY = 24 * 60 * 60;

const retentionSeconds = computed(
  () => Math.max(1, Math.floor(props.retentionDays)) * SECONDS_PER_DAY,
);

const selected = computed(() =>
  props.modelValue.kind === 'window' ? props.modelValue.window : 'custom',
);

/**
 * The bounds a range has to fit inside, with the present as the ceiling.
 *
 * The caller's ceiling can be up to one poll old, so the later of the two wins: a range that is
 * current as this is read must never be slid backwards into the past.
 */
function effectiveBounds(): TimeBounds | null {
  if (props.bounds === null) return null;
  const now = Math.floor(Date.now() / 1_000);
  return { from: props.bounds.from, to: Math.max(props.bounds.to, now) };
}

/**
 * Fit a range inside the retained bounds, keeping its span.
 *
 * Typing a date before the retention horizon or a moment in the future is not an error worth
 * refusing — there is simply no history there — so the range slides to the nearest range that
 * exists instead of leaving the view pointing at nothing.
 */
function boundedRange(from: number, to: number): { from: number; to: number } {
  const bounds = effectiveBounds();
  if (bounds === null) return { from, to };
  const clamped = clampTimelineRange({ from, to }, bounds, props.minimumSpanSeconds);
  return { from: clamped.from, to: clamped.to };
}

function recentRange(): { from: number; to: number } {
  // Whole units, so the drafts seeded into the inputs match the applied value exactly and Apply
  // does not look pending the moment Custom is chosen.
  const unit = props.secondsPrecision ? 1_000 : 60_000;
  const to = Math.floor(Date.now() / unit) * (unit / 1_000);
  const span = Math.min(props.defaultCustomSpanSeconds, retentionSeconds.value);
  return boundedRange(Math.max(0, to - span), to);
}

const fromInput = ref('');
const toInput = ref('');

/** Follow the applied selection, so switching presets or applying a range resyncs the inputs. */
watch(
  () => props.modelValue,
  (value) => {
    const range = value.kind === 'range' ? value : recentRange();
    const options = { seconds: props.secondsPrecision };
    fromInput.value = unixSecondsToLocalInput(range.from, options);
    toInput.value = unixSecondsToLocalInput(range.to, options);
  },
  { immediate: true },
);

function isHistoryWindow(value: string): value is HistoryWindow {
  return (HISTORY_WINDOWS as readonly string[]).includes(value);
}

function onPresetChange(value: string): void {
  if (!isHistoryWindow(value)) {
    // Emitting straight away keeps the chart showing data while the operator edits the drafts;
    // the watcher above then seeds the inputs from the applied bounds.
    emit('update:modelValue', { kind: 'range', ...recentRange() });
    return;
  }
  emit('update:modelValue', { kind: 'window', window: value });
}

/** Draft bounds, or `null` when either input is not a usable local date and time. */
const draft = computed(() => {
  const from = localInputToUnixSeconds(fromInput.value);
  const to = localInputToUnixSeconds(toInput.value);
  return from === null || to === null ? null : { from, to };
});

const validationError = computed(() => {
  if (props.modelValue.kind !== 'range') return null;
  if (draft.value === null) return 'Enter a valid start and end date and time.';
  const { from, to } = draft.value;
  if (to <= from) return 'The end must be later than the start.';
  if (to - from < props.minimumSpanSeconds) {
    return `Ranges must cover at least ${formatInterval(props.minimumSpanSeconds)}.`;
  }
  if (to - from > retentionSeconds.value) {
    return `Custom ranges are limited to the ${Math.floor(props.retentionDays)} days of history this server keeps.`;
  }
  return null;
});

const dirty = computed(() => {
  if (props.modelValue.kind !== 'range' || draft.value === null) return false;
  return draft.value.from !== props.modelValue.from || draft.value.to !== props.modelValue.to;
});

function apply(): void {
  if (draft.value === null || validationError.value !== null) return;
  emit('update:modelValue', { kind: 'range', ...boundedRange(draft.value.from, draft.value.to) });
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col gap-1">
      <span
        class="text-[10px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400"
      >
        {{ label }}
      </span>
      <select
        class="input w-auto py-1 text-xs"
        :value="selected"
        @change="onPresetChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="window in HISTORY_WINDOWS" :key="window" :value="window">
          {{ window }}
        </option>
        <option value="custom">Custom range</option>
      </select>
    </label>

    <template v-if="modelValue.kind === 'range'">
      <label class="flex flex-col gap-1">
        <span
          class="text-[10px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400"
        >
          From
        </span>
        <input
          v-model="fromInput"
          type="datetime-local"
          class="input w-auto py-1 text-xs"
          :step="secondsPrecision ? 1 : 60"
          :aria-invalid="validationError !== null"
          @keydown.enter.prevent="apply"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span
          class="text-[10px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400"
        >
          To
        </span>
        <input
          v-model="toInput"
          type="datetime-local"
          class="input w-auto py-1 text-xs"
          :step="secondsPrecision ? 1 : 60"
          :aria-invalid="validationError !== null"
          @keydown.enter.prevent="apply"
        />
      </label>

      <button
        type="button"
        class="btn-secondary btn-xs"
        :disabled="validationError !== null || !dirty"
        @click="apply"
      >
        Apply
      </button>
    </template>

    <p
      v-if="validationError !== null"
      class="w-full text-xs text-rose-600 dark:text-rose-400"
      role="alert"
    >
      {{ validationError }}
    </p>
  </div>
</template>
