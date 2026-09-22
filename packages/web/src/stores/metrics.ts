import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_WINDOWS,
  type HistorySelection,
  type HistoryWindow,
} from '@palsentry/shared';

export type MetricKey = 'onlinePlayers' | 'serverFps' | 'bases' | 'serverFrameTime';
export type MetricSelections = Record<MetricKey, HistorySelection>;

export const METRIC_KEYS: readonly MetricKey[] = [
  'onlinePlayers',
  'serverFps',
  'bases',
  'serverFrameTime',
];

const STORAGE_KEY = 'palsentry:metricFilters:v1';
const SECONDS_PER_DAY = 24 * 60 * 60;

function defaultSelection(): HistorySelection {
  return { kind: 'window', window: DEFAULT_HISTORY_WINDOW };
}

function defaultSelections(): MetricSelections {
  return {
    onlinePlayers: defaultSelection(),
    serverFps: defaultSelection(),
    bases: defaultSelection(),
    serverFrameTime: defaultSelection(),
  };
}

function normaliseSelection(value: unknown): HistorySelection | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null;

  if (value.kind === 'window' && 'window' in value) {
    const window = value.window;
    return typeof window === 'string' && HISTORY_WINDOWS.includes(window as HistoryWindow)
      ? { kind: 'window', window: window as HistoryWindow }
      : null;
  }

  if (value.kind === 'range' && 'from' in value && 'to' in value) {
    const from = value.from;
    const to = value.to;
    return typeof from === 'number' &&
      Number.isSafeInteger(from) &&
      from >= 0 &&
      typeof to === 'number' &&
      Number.isSafeInteger(to) &&
      to > from
      ? { kind: 'range', from, to }
      : null;
  }

  return null;
}

function readSelections(): MetricSelections {
  const fallback = defaultSelections();

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return fallback;
    const parsed = JSON.parse(stored) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    for (const key of METRIC_KEYS) {
      const selection = normaliseSelection((parsed as Record<string, unknown>)[key]);
      if (selection !== null) fallback[key] = selection;
    }
  } catch {
    // Corrupt JSON or blocked storage should never stop the Metrics view from loading.
  }

  return fallback;
}

/** Browser-persistent filter selections; chart data itself remains route-scoped. */
export const useMetricsStore = defineStore('metrics', () => {
  const selections = ref<MetricSelections>(readSelections());

  function setSelection(key: MetricKey, selection: HistorySelection): void {
    const normalized = normaliseSelection(selection);
    selections.value[key] = normalized ?? defaultSelection();
  }

  function resetSelection(key: MetricKey): void {
    selections.value[key] = defaultSelection();
  }

  /** Drop ranges that became invalid after an operator reduced history retention. */
  function constrainToRetention(retentionDays: number): void {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
    const maximumSpan = Math.floor(retentionDays * SECONDS_PER_DAY);
    for (const key of METRIC_KEYS) {
      const selection = selections.value[key];
      if (selection.kind === 'range' && selection.to - selection.from > maximumSpan) {
        resetSelection(key);
      }
    }
  }

  watch(
    selections,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Private browsing/storage quotas should degrade to in-memory state.
      }
    },
    { deep: true },
  );

  return { selections, setSelection, resetSelection, constrainToRetention };
});
