<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** Optional call to action rendered under the text. */
    actionLabel?: string;
  }>(),
  { description: undefined, actionLabel: undefined },
);

defineEmits<{ action: [] }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    <slot name="icon" />
    <p class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ title }}</p>
    <p v-if="description" class="max-w-md text-xs text-slate-500 dark:text-slate-400">
      {{ description }}
    </p>
    <button
      v-if="actionLabel"
      type="button"
      class="btn-secondary btn-xs mt-1"
      @click="$emit('action')"
    >
      {{ actionLabel }}
    </button>
  </div>
</template>
