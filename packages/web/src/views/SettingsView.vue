<script setup lang="ts">
import { computed, ref } from 'vue';
import { Info, RefreshCw, Search } from '@lucide/vue';
import type { PalworldSettings } from '@palsentry/shared';
import {
  SETTINGS_GROUPS,
  formatSettingValue,
  humanizeSettingKey,
  isTruthySettingValue,
} from '@palsentry/shared';
import { api, errorMessage } from '@/lib/api';
import { usePolling } from '@/composables/usePolling';
import EmptyState from '@/components/EmptyState.vue';

const settings = ref<PalworldSettings>({});
const loading = ref(true);
const loadError = ref<string | null>(null);
const search = ref('');
const collapsed = ref<Set<string>>(new Set());

/**
 * The settings dump changes only on a server restart, so this polls slowly — there is no reason
 * to ask the game server for it every few seconds.
 */
const { run: reload } = usePolling(
  async () => {
    try {
      settings.value = (await api.settings()).settings;
      loadError.value = null;
    } catch (error) {
      loadError.value = errorMessage(error);
    } finally {
      loading.value = false;
    }
  },
  { intervalMs: 60_000 },
);

const query = computed(() => search.value.trim().toLowerCase());
const compactQuery = computed(() => query.value.replace(/[^a-z0-9]+/g, ''));

/**
 * Build the grouped view.
 *
 * Keys the server returns that are not in any group land in a trailing "Other" group rather than
 * being dropped, so a key added by a future game update still shows up.
 */
const groups = computed(() => {
  const all = settings.value;
  const assigned = new Set<string>();

  const matches = (key: string): boolean => {
    if (query.value === '') return true;

    return [key, humanizeSettingKey(key), String(all[key])].some((candidate) => {
      const lower = candidate.toLowerCase();
      return (
        lower.includes(query.value) ||
        (compactQuery.value !== '' && lower.replace(/[^a-z0-9]+/g, '').includes(compactQuery.value))
      );
    });
  };

  const result = SETTINGS_GROUPS.map((group) => {
    const rows = group.keys
      .filter((key) => key in all)
      .map((key) => {
        assigned.add(key);
        return { key, value: all[key] };
      })
      .filter((row) => matches(row.key));

    return {
      id: group.id,
      label: group.label,
      description: group.description,
      rows,
    };
  }).filter((group) => group.rows.length > 0);

  const leftovers = Object.keys(all)
    .filter((key) => !assigned.has(key))
    .filter(matches)
    .map((key) => ({ key, value: all[key] }));

  if (leftovers.length > 0) {
    result.push({
      id: 'other',
      label: 'Other',
      description: 'Keys this build of Palsentry does not recognise yet.',
      rows: leftovers,
    });
  }

  return result;
});

const totalShown = computed(() => groups.value.reduce((sum, group) => sum + group.rows.length, 0));
const totalSettings = computed(() => Object.keys(settings.value).length);

function toggleGroup(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function isCollapsed(id: string): boolean {
  // While searching, force everything open so matches are never hidden behind a fold.
  return query.value === '' && collapsed.value.has(id);
}

/** Count the boolean toggles that are currently on, for the group summary. */
function enabledCount(rows: { key: string; value: string | number | boolean }[]): number {
  return rows.filter((row) => isTruthySettingValue(row.value)).length;
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">Server settings</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          {{ totalSettings }} keys resolved from PalWorldSettings.ini
        </p>
      </div>
      <button type="button" class="btn-secondary btn-xs" @click="reload()">
        <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        Refresh
      </button>
    </div>

    <div
      class="flex items-start gap-2 rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-xs text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/50 dark:text-sky-100"
      role="note"
    >
      <Info class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span class="text-red-500"> Read-only. Shows the current server settings. </span>
    </div>

    <div
      v-if="loadError"
      class="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-100"
      role="alert"
    >
      {{ loadError }}
    </div>

    <div class="relative max-w-sm">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        v-model="search"
        type="search"
        class="input pl-8"
        placeholder="Search keys or values"
        aria-label="Search settings"
      />
    </div>

    <EmptyState
      v-if="!loading && totalSettings === 0 && loadError === null"
      title="No settings returned"
      description="The Palworld server answered but returned an empty settings object."
    />

    <p v-else-if="loading && totalSettings === 0" class="py-8 text-center text-xs text-slate-500">
      Loading settings…
    </p>

    <p v-else-if="query !== '' && totalShown === 0" class="py-8 text-center text-xs text-slate-500">
      No settings match “{{ search }}”.
    </p>

    <div v-else class="space-y-3">
      <section v-for="group in groups" :key="group.id" class="card">
        <button
          type="button"
          class="card-header w-full text-left"
          :aria-expanded="!isCollapsed(group.id)"
          @click="toggleGroup(group.id)"
        >
          <div>
            <h2 class="card-title">{{ group.label }}</h2>
            <p class="mt-0.5 text-xs font-normal normal-case text-slate-500 dark:text-slate-400">
              {{ group.description }}
            </p>
          </div>
          <span class="shrink-0 text-xs text-slate-400">
            {{ group.rows.length }}
            <template v-if="enabledCount(group.rows) > 0">
              · {{ enabledCount(group.rows) }} on
            </template>
          </span>
        </button>

        <dl
          v-if="!isCollapsed(group.id)"
          class="divide-y divide-slate-100 dark:divide-slate-800/60"
        >
          <div
            v-for="row in group.rows"
            :key="row.key"
            class="flex items-baseline justify-between gap-4 px-4 py-2"
          >
            <dt class="min-w-0">
              <span class="text-sm text-slate-700 dark:text-slate-200">
                {{ humanizeSettingKey(row.key) }}
              </span>
              <span class="block font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {{ row.key }}
              </span>
            </dt>
            <dd class="shrink-0 text-right">
              <span
                v-if="typeof row.value === 'boolean'"
                class="badge"
                :class="
                  row.value
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                "
              >
                {{ formatSettingValue(row.value) }}
              </span>
              <span
                v-else
                class="font-mono text-sm tabular-nums text-slate-800 dark:text-slate-100"
              >
                {{ formatSettingValue(row.value) }}
              </span>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>
