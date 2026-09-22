<script setup lang="ts">
import { computed } from 'vue';
import type { HistorySample, HistorySelection } from '@palsentry/shared';
import { formatHistoryRange } from '@/lib/format';
import { useMetricHistory } from '@/composables/useMetricHistory';
import { useMetricsStore, type MetricKey } from '@/stores/metrics';
import { useServerStore } from '@/stores/server';
import MetricChart from './MetricChart.vue';
import HistoryRangeFilter from './HistoryRangeFilter.vue';

const props = withDefaults(
  defineProps<{
    metric: MetricKey;
    title: string;
    colour: string;
    /** Reads the plotted series out of a stored sample. */
    value: (sample: HistorySample) => number;
    description?: string;
    unit?: string;
    /** Axis precision; see `MetricChart`. */
    decimals?: number;
    /** Plotted height in pixels. */
    height?: number;
  }>(),
  { description: '', unit: '', decimals: undefined, height: 160 },
);

/**
 * One metric card: its own filter, its own request, its own error and empty states.
 *
 * Nothing is shared between cards except the store that remembers each selection, which is what
 * keeps re-ranging one chart from reloading the other three.
 */
const metrics = useMetricsStore();
const server = useServerStore();

const selection = computed<HistorySelection>(() => metrics.selections[props.metric]);

const sampleIntervalSeconds = computed(() => server.meta?.history.sampleIntervalSeconds ?? 60);
const retentionDays = computed(() => server.meta?.history.retentionDays ?? 30);

// Polling faster than the sampler writes rows would just repeat the same buckets.
const pollIntervalMs = computed(() => Math.max(sampleIntervalSeconds.value, 1) * 1_000);

const { response, error, loading, refreshing, reload } = useMetricHistory(
  selection,
  pollIntervalMs,
);

function updateSelection(next: HistorySelection): void {
  metrics.setSelection(props.metric, next);
}

const points = computed(
  () =>
    response.value?.samples.map((sample) => ({ ts: sample.ts, value: props.value(sample) })) ?? [],
);

const rangeLabel = computed(() => {
  if (response.value === null) return 'the selected range';
  return formatHistoryRange(response.value.from, response.value.to);
});

const isEmpty = computed(() => response.value !== null && response.value.samples.length === 0);
</script>

<template>
  <section class="card">
    <div class="card-header flex-wrap items-end gap-2">
      <div class="min-w-0">
        <h2 class="card-title">{{ title }}</h2>
        <p v-if="description !== ''" class="text-xs text-slate-500 dark:text-slate-400">
          {{ description }}
        </p>
      </div>
      <HistoryRangeFilter
        :model-value="selection"
        :retention-days="retentionDays"
        class="ml-auto"
        @update:model-value="updateSelection"
      />
    </div>

    <div class="p-4 pt-0">
      <p
        v-if="error !== null"
        class="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
        role="alert"
      >
        {{ error }}
        <button type="button" class="ml-1 underline" @click="reload()">Retry</button>
      </p>

      <p v-if="loading" class="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
        Loading history…
      </p>

      <p
        v-else-if="isEmpty"
        class="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"
      >
        No samples in this range. PalSentry records one every
        {{ sampleIntervalSeconds }}s.
      </p>

      <MetricChart
        v-else-if="response !== null"
        :points="points"
        :label="title"
        :colour="colour"
        :range-label="rangeLabel"
        :unit="unit"
        :decimals="decimals"
        :height="height"
        :class="refreshing ? 'opacity-70 transition-opacity' : ''"
      />
    </div>
  </section>
</template>
