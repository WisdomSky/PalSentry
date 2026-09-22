<script setup lang="ts">
import { CheckCircle2, Info, X, XCircle } from '@lucide/vue';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore();

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
} as const;

const TONES = {
  success:
    'border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/80 dark:text-emerald-100',
  error: 'border-rose-500/40 bg-rose-50 text-rose-900 dark:bg-rose-950/80 dark:text-rose-100',
  info: 'border-slate-400/40 bg-white text-slate-900 dark:bg-slate-900/95 dark:text-slate-100',
} as const;

const ICON_TONES = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-rose-600 dark:text-rose-400',
  info: 'text-sky-600 dark:text-sky-400',
} as const;
</script>

<template>
  <!--
    Fixed-position toast stack. `aria-live` announces new toasts to screen readers, which is how
    someone using a keyboard learns that a kick succeeded without hunting for the table.
  -->
  <div
    class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
    role="region"
    aria-label="Notifications"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-for="toast in ui.toasts"
        :key="toast.id"
        class="pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-3 shadow-lg backdrop-blur"
        :class="TONES[toast.kind]"
        :role="toast.kind === 'error' ? 'alert' : 'status'"
        aria-live="polite"
      >
        <div class="flex items-start gap-3">
          <component
            :is="ICONS[toast.kind]"
            class="mt-0.5 h-4 w-4 shrink-0"
            :class="ICON_TONES[toast.kind]"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{{ toast.title }}</p>
            <p v-if="toast.detail" class="mt-0.5 text-xs break-words opacity-80">
              {{ toast.detail }}
            </p>
          </div>
          <button
            type="button"
            class="-m-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
            aria-label="Dismiss notification"
            @click="ui.dismiss(toast.id)"
          >
            <X class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>
