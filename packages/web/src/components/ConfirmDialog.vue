<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { X } from '@lucide/vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** Set for destructive confirmations so the primary button reads as dangerous. */
    tone?: 'default' | 'danger';
    confirmLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
  }>(),
  {
    tone: 'default',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    busy: false,
  },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);

/**
 * Drive the native <dialog> element.
 *
 * Using the platform element rather than a div gives focus trapping, Escape-to-close, and inert
 * background content for free — all of which matter for a dialog guarding a destructive action.
 */
watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (dialog.value === null) return;
    if (open) {
      if (!dialog.value.open) dialog.value.showModal();
    } else if (dialog.value.open) {
      dialog.value.close();
    }
  },
  { immediate: true },
);

/** Treat Escape / backdrop dismissal as a cancel rather than leaving state ambiguous. */
function onCancel(event: Event): void {
  event.preventDefault();
  if (!props.busy) emit('cancel');
}
</script>

<template>
  <dialog
    ref="dialog"
    class="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    @cancel="onCancel"
    @close="emit('cancel')"
  >
    <div
      class="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3 dark:border-slate-800"
    >
      <h2 class="text-sm font-semibold">{{ title }}</h2>
      <button
        type="button"
        class="btn-ghost btn-xs -m-1"
        aria-label="Close dialog"
        :disabled="busy"
        @click="emit('cancel')"
      >
        <X class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>

    <div class="space-y-3 px-4 py-4 text-sm">
      <slot />
    </div>

    <div class="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
      <button type="button" class="btn-secondary" :disabled="busy" @click="emit('cancel')">
        {{ cancelLabel }}
      </button>
      <button
        type="button"
        :class="tone === 'danger' ? 'btn-danger' : 'btn-primary'"
        :disabled="busy"
        @click="emit('confirm')"
      >
        {{ busy ? 'Working…' : confirmLabel }}
      </button>
    </div>
  </dialog>
</template>
