<script setup lang="ts">
import { computed } from 'vue';
import { Loader2, Wifi, WifiOff } from '@lucide/vue';

const props = withDefaults(
  defineProps<{
    /** null while the first status request is still in flight. */
    online: boolean | null;
    /** Optional detail line, e.g. the failure reason. */
    detail?: string | null;
    compact?: boolean;
  }>(),
  { detail: null, compact: false },
);

const state = computed<'checking' | 'online' | 'offline'>(() => {
  if (props.online === null) return 'checking';
  return props.online ? 'online' : 'offline';
});

const LABEL = {
  checking: 'Checking…',
  online: 'Online',
  offline: 'Offline',
} as const;

const STYLES = {
  checking: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  online: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  offline: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
} as const;

const DOT = {
  checking: 'bg-slate-400',
  online: 'bg-emerald-500 animate-pulse',
  offline: 'bg-rose-500',
} as const;
</script>

<template>
  <span class="badge" :class="STYLES[state]" :title="detail ?? LABEL[state]">
    <Loader2 v-if="state === 'checking'" class="h-3 w-3 animate-spin" aria-hidden="true" />
    <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT[state]" aria-hidden="true" />
    <Wifi v-if="state === 'online' && !compact" class="h-3 w-3" aria-hidden="true" />
    <WifiOff v-else-if="state === 'offline' && !compact" class="h-3 w-3" aria-hidden="true" />
    {{ LABEL[state] }}
  </span>
</template>
