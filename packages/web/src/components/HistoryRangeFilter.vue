<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { HISTORY_WINDOWS, type HistorySelection, type HistoryWindow } from '@palsentry/shared';
import { localInputToUnixSeconds, unixSecondsToLocalInput } from '@/lib/format';

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
  }>(),
  { label: 'Range', defaultCustomSpanSeconds: 6 * 60 * 60 },
);

const emit = defineEmits<{ 'update:modelValue': [HistorySelection] }>();

const SECONDS_PER_DAY = 24 * 60 * 60;

const retentionSeconds = computed(
  () => Math.max(1, Math.floor(props.retentionDays)) * SECONDS_PER_DAY,
);

const selected = computed(() =>
  props.modelValue.kind === 'window' ? props.modelValue.window : 'custom',
);

function recentRange(): { from: number; to: number } {
  // Whole minutes, so the drafts seeded into the inputs match the applied value exactly and Apply
  // does not look pending the moment Custom is chosen.
  const to = Math.floor(Date.now() / 60_000) * 60;
  const span = Math.min(props.defaultCustomSpanSeconds, retentionSeconds.value);
  return { from: Math.max(0, to - span), to };
}

const fromInput = ref('');
const toInput = ref('');

/** Follow the applied selection, so switching presets or applying a range resyncs the inputs. */
watch(
  () => props.modelValue,
  (value) => {
    const range = value.kind === 'range' ? value : recentRange();
    fromInput.value = unixSecondsToLocalInput(range.from);
    toInput.value = unixSecondsToLocalInput(range.to);
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
  emit('update:modelValue', { kind: 'range', ...draft.value });
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
