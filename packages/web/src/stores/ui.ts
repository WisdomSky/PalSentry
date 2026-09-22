import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { DEFAULT_POLL_INTERVAL_MS, POLL_INTERVAL_OPTIONS } from '@palsentry/shared';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

const THEME_KEY = 'palsentry:theme';
const POLL_KEY = 'palsentry:pollInterval';
const TOAST_TIMEOUT_MS = 6_000;
/** Errors stay up longer: they usually contain something the operator needs to read. */
const ERROR_TIMEOUT_MS = 12_000;

type Theme = 'dark' | 'light';

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  // Dark by default: this is a dashboard that sits open next to a game.
  return 'dark';
}

function readStoredPollInterval(): number {
  const raw = localStorage.getItem(POLL_KEY);
  if (raw === null) return DEFAULT_POLL_INTERVAL_MS;

  const stored = Number(raw);
  return POLL_INTERVAL_OPTIONS.includes(stored as (typeof POLL_INTERVAL_OPTIONS)[number])
    ? stored
    : DEFAULT_POLL_INTERVAL_MS;
}

/** Cross-cutting UI state: theme, toast notifications, and the polling cadence. */
export const useUiStore = defineStore('ui', () => {
  const theme = ref<Theme>(readStoredTheme());
  const pollIntervalMs = ref<number>(readStoredPollInterval());
  const toasts = ref<Toast[]>([]);
  let nextToastId = 1;

  function applyTheme(value: Theme): void {
    document.documentElement.classList.toggle('dark', value === 'dark');
    document.documentElement.style.colorScheme = value;
  }

  function setTheme(value: Theme): void {
    theme.value = value;
    localStorage.setItem(THEME_KEY, value);
    applyTheme(value);
  }

  function toggleTheme(): void {
    setTheme(theme.value === 'dark' ? 'light' : 'dark');
  }

  /** Called once at startup, before mount, to avoid a flash of the wrong theme. */
  function initialise(): void {
    applyTheme(theme.value);
  }

  function setPollInterval(ms: number): void {
    if (!POLL_INTERVAL_OPTIONS.includes(ms as (typeof POLL_INTERVAL_OPTIONS)[number])) return;
    pollIntervalMs.value = ms;
    localStorage.setItem(POLL_KEY, String(ms));
  }

  function push(kind: ToastKind, title: string, detail?: string): number {
    const id = nextToastId++;
    toasts.value = [
      ...toasts.value,
      { id, kind, title, ...(detail === undefined ? {} : { detail }) },
    ];

    const timeout = kind === 'error' ? ERROR_TIMEOUT_MS : TOAST_TIMEOUT_MS;
    setTimeout(() => dismiss(id), timeout);

    return id;
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  const success = (title: string, detail?: string) => push('success', title, detail);
  const error = (title: string, detail?: string) => push('error', title, detail);
  const info = (title: string, detail?: string) => push('info', title, detail);

  const isPolling = computed(() => pollIntervalMs.value > 0);

  // Persist on change, and keep <html> in sync if something else flips the value.
  watch(theme, (value) => applyTheme(value));

  return {
    theme,
    pollIntervalMs,
    toasts,
    isPolling,
    initialise,
    setTheme,
    toggleTheme,
    setPollInterval,
    push,
    dismiss,
    success,
    error,
    info,
  };
});
