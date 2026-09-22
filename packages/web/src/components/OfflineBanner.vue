<script setup lang="ts">
import { AlertTriangle, RefreshCw } from '@lucide/vue';

defineProps<{
  message: string;
  /** Extra guidance, e.g. the Palworld configuration hint from the API error. */
  hint?: string | null;
}>();

defineEmits<{ retry: [] }>();
</script>

<template>
  <!--
    Shown instead of blank cards when the game server is unreachable. The message comes straight
    from the API's error mapping, so it names the actual cause (connection refused vs. bad
    credentials vs. wrong port) rather than a generic failure.
  -->
  <div
    class="flex flex-col gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-rose-900 sm:flex-row sm:items-center sm:justify-between dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-100"
    role="alert"
  >
    <div class="flex items-start gap-3">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div class="space-y-0.5">
        <p class="text-sm font-medium">Palworld server unreachable</p>
        <p class="text-xs opacity-90">{{ message }}</p>
        <p v-if="hint" class="text-xs opacity-70">{{ hint }}</p>
      </div>
    </div>
    <button type="button" class="btn-secondary btn-xs shrink-0" @click="$emit('retry')">
      <RefreshCw class="h-3 w-3" aria-hidden="true" />
      Retry
    </button>
  </div>
</template>
