<script setup lang="ts">
import { computed, watch } from 'vue';
import type { HistorySample } from '@palsentry/shared';
import { useServerStore } from '@/stores/server';
import { useMetricsStore, type MetricKey } from '@/stores/metrics';
import MetricPanel from '@/components/MetricPanel.vue';

/**
 * Historical metrics, one full-width chart per row.
 *
 * History is deliberately outside the global server poll: it is only needed here, each chart owns
 * an independent range filter, and the queries are far more expensive to serve than a status
 * snapshot. The panels unmount (and stop polling) as soon as the operator navigates away.
 */
const server = useServerStore();
const metrics = useMetricsStore();

interface MetricCard {
  key: MetricKey;
  title: string;
  description: string;
  colour: string;
  unit: string;
  /** Axis precision: counts are whole numbers, frame time is a duration in tenths. */
  decimals: number;
  value: (sample: HistorySample) => number;
}

const CARDS: readonly MetricCard[] = [
  {
    key: 'onlinePlayers',
    title: 'Players online',
    description: 'Average concurrent players in each sampled bucket.',
    colour: '#6366f1',
    unit: '',
    decimals: 0,
    value: (sample) => sample.currentplayernum,
  },
  {
    key: 'bases',
    title: 'Base camps',
    description: 'Number of placed bases across the world.',
    colour: '#f59e0b',
    unit: '',
    decimals: 0,
    value: (sample) => sample.basecampnum,
  },
  {
    key: 'serverFps',
    title: 'Server FPS',
    description: 'Palworld’s own frame rate. Sustained dips below 30 show up in play.',
    colour: '#14b8a6',
    unit: ' fps',
    decimals: 0,
    value: (sample) => sample.serverfps,
  },
  {
    key: 'serverFrameTime',
    title: 'Server frame time',
    description: 'Milliseconds per frame — the inverse of server FPS, at finer resolution.',
    colour: '#ec4899',
    unit: ' ms',
    decimals: 1,
    value: (sample) => sample.serverframetime,
  },
];

const retentionDays = computed(() => server.meta?.history.retentionDays ?? 30);
const sampleIntervalSeconds = computed(() => server.meta?.history.sampleIntervalSeconds ?? 60);

// A persisted custom range can outlive a retention change (an operator lowering
// PALSENTRY_HISTORY_RETENTION_DAYS), so re-check it against the server's current limit.
watch(retentionDays, (days) => metrics.constrainToRetention(days), { immediate: true });
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-lg font-semibold tracking-tight">Metrics</h1>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Sampled every {{ sampleIntervalSeconds }}s and kept for {{ retentionDays }} days. Each chart
        has its own range.
      </p>
    </div>

    <MetricPanel
      v-for="card in CARDS"
      :key="card.key"
      :metric="card.key"
      :title="card.title"
      :description="card.description"
      :colour="card.colour"
      :unit="card.unit"
      :decimals="card.decimals"
      :value="card.value"
    />
  </div>
</template>
