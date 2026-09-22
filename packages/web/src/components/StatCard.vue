<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    value: string;
    /** Optional secondary line under the value. */
    hint?: string | null;
    /** Tailwind text colour class for the value. */
    tone?: string;
  }>(),
  { hint: null, tone: 'text-slate-900 dark:text-slate-100' },
);
</script>

<template>
  <div class="card px-4 py-3">
    <div class="flex items-start justify-between gap-2">
      <p class="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {{ label }}
      </p>
      <slot name="icon" />
    </div>
    <p class="mt-1 text-2xl leading-tight font-semibold tabular-nums" :class="tone">
      {{ value }}
    </p>
    <p v-if="hint" class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{{ hint }}</p>
    <slot />
  </div>
</template>
