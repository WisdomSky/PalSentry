<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ScrollText,
  XCircle,
} from '@lucide/vue';
import type { AuditEntry } from '@palsentry/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { usePolling } from '@/composables/usePolling';
import { useUiStore } from '@/stores/ui';
import EmptyState from '@/components/EmptyState.vue';

const ui = useUiStore();

const entries = ref<AuditEntry[]>([]);
const total = ref(0);
const loading = ref(true);

const PAGE_SIZE = 25;
const page = ref(0);

const filters = ref({ action: '', actor: '', target: '', ok: '' });
const expanded = ref<number | null>(null);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const hasPrevious = computed(() => page.value > 0);
const hasNext = computed(() => page.value < totalPages.value - 1);

const activeFilterCount = computed(
  () => Object.values(filters.value).filter((value) => value !== '').length,
);

async function load(): Promise<void> {
  try {
    const query = {
      limit: PAGE_SIZE,
      offset: page.value * PAGE_SIZE,
      ...(filters.value.action === '' ? {} : { action: filters.value.action }),
      ...(filters.value.actor === '' ? {} : { actor: filters.value.actor }),
      ...(filters.value.target === '' ? {} : { target: filters.value.target }),
      ...(filters.value.ok === '' ? {} : { ok: filters.value.ok === 'true' }),
    };

    const response = await api.audit(query);
    entries.value = response.entries;
    total.value = response.total;
  } catch (error) {
    ui.error('Could not load the audit log', errorMessage(error));
  } finally {
    loading.value = false;
  }
}

/**
 * The trail changes only when someone acts, so a slow poll is plenty — and it keeps the view
 * current when two admins are working at once.
 */
const { run: reload } = usePolling(load, { intervalMs: 20_000 });

function applyFilters(): void {
  // Any filter change invalidates the current page offset.
  page.value = 0;
  void reload();
}

function goToPage(next: number): void {
  page.value = Math.min(Math.max(0, next), totalPages.value - 1);
  void reload();
}

function clearFilters(): void {
  filters.value = { action: '', actor: '', target: '', ok: '' };
  applyFilters();
}

function toggle(id: number): void {
  expanded.value = expanded.value === id ? null : id;
}

/** Actions the API records, for the filter dropdown. */
const ACTION_CHOICES = [
  'announce',
  'save',
  'kick',
  'ban',
  'unban',
  'shutdown',
  'stop',
  'restart',
  'bans.delete',
];
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">Audit log</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          {{ total }} {{ total === 1 ? 'entry' : 'entries' }}, newest first. Append-only.
        </p>
      </div>
      <button type="button" class="btn-secondary btn-xs" @click="reload()">
        <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        Refresh
      </button>
    </div>

    <!-- Filters -->
    <section class="card p-4">
      <form class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" @submit.prevent="applyFilters">
        <label class="block">
          <span class="label">Action</span>
          <select v-model="filters.action" class="input py-1 text-xs" @change="applyFilters">
            <option value="">Any</option>
            <option v-for="action in ACTION_CHOICES" :key="action" :value="action">
              {{ action }}
            </option>
          </select>
        </label>

        <label class="block">
          <span class="label">Actor</span>
          <input
            v-model="filters.actor"
            class="input py-1 text-xs"
            placeholder="username or IP"
            @change="applyFilters"
          />
        </label>

        <label class="block">
          <span class="label">Target</span>
          <input
            v-model="filters.target"
            class="input py-1 font-mono text-xs"
            placeholder="player id"
            @change="applyFilters"
          />
        </label>

        <label class="block">
          <span class="label">Outcome</span>
          <select v-model="filters.ok" class="input py-1 text-xs" @change="applyFilters">
            <option value="">Any</option>
            <option value="true">Succeeded</option>
            <option value="false">Failed</option>
          </select>
        </label>

        <div class="flex items-end">
          <button
            type="button"
            class="btn-secondary btn-xs w-full"
            :disabled="activeFilterCount === 0"
            @click="clearFilters"
          >
            Clear filters
          </button>
        </div>
      </form>
    </section>

    <!-- Entries -->
    <section class="card">
      <EmptyState
        v-if="!loading && entries.length === 0"
        :title="
          activeFilterCount > 0 ? 'No entries match those filters' : 'No activity recorded yet'
        "
        :description="
          activeFilterCount > 0
            ? 'Try widening or clearing the filters.'
            : 'Every action Palsentry performs — successful or not — is recorded here.'
        "
      >
        <template #icon
          ><ScrollText class="h-6 w-6 text-slate-300 dark:text-slate-700" aria-hidden="true"
        /></template>
      </EmptyState>

      <div v-else class="overflow-x-auto">
        <table class="w-full border-collapse">
          <caption class="sr-only">
            Audit trail
          </caption>
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800">
              <th scope="col" class="table-head w-8"></th>
              <th scope="col" class="table-head">Time</th>
              <th scope="col" class="table-head">Action</th>
              <th scope="col" class="table-head">Target</th>
              <th scope="col" class="table-head">Actor</th>
              <th scope="col" class="table-head text-right">Result</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in entries" :key="entry.id">
              <tr
                class="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40"
                @click="toggle(entry.id)"
              >
                <td class="cell text-center">
                  <component
                    :is="entry.ok ? CheckCircle2 : XCircle"
                    class="mx-auto h-3.5 w-3.5"
                    :class="entry.ok ? 'text-emerald-500' : 'text-rose-500'"
                    :aria-label="entry.ok ? 'Succeeded' : 'Failed'"
                  />
                </td>
                <td class="cell" :title="formatDateTime(entry.ts)">
                  {{ formatRelative(entry.ts) }}
                </td>
                <td class="cell font-medium">{{ entry.action }}</td>
                <td class="cell font-mono text-xs">{{ entry.target ?? '—' }}</td>
                <td class="cell text-xs">
                  {{ entry.actorName ?? '—' }}
                  <span
                    v-if="entry.actorIp"
                    class="block font-mono text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    {{ entry.actorIp }}
                  </span>
                </td>
                <td class="cell text-right text-xs tabular-nums">
                  <span v-if="entry.httpStatus !== null">{{ entry.httpStatus }}</span>
                  <span v-if="entry.durationMs !== null" class="ml-2 text-slate-400">
                    {{ entry.durationMs }}ms
                  </span>
                </td>
              </tr>

              <!-- Expanded detail: the exact payload and error, which is what makes this useful. -->
              <tr
                v-if="expanded === entry.id"
                class="border-b border-slate-100 bg-slate-50 dark:border-slate-800/60 dark:bg-slate-800/40"
              >
                <td colspan="6" class="px-4 py-3">
                  <dl class="space-y-2 text-xs">
                    <div>
                      <dt class="font-medium text-slate-500 dark:text-slate-400">Timestamp</dt>
                      <dd class="font-mono">{{ formatDateTime(entry.ts) }}</dd>
                    </div>
                    <div v-if="entry.error">
                      <dt class="font-medium text-rose-600 dark:text-rose-400">Error</dt>
                      <dd class="text-rose-700 dark:text-rose-300">{{ entry.error }}</dd>
                    </div>
                    <div>
                      <dt class="font-medium text-slate-500 dark:text-slate-400">
                        Request payload
                      </dt>
                      <dd>
                        <pre
                          class="overflow-x-auto rounded bg-slate-900 p-2 font-mono text-[11px] text-slate-100"
                          >{{
                            entry.payload === null ? '—' : JSON.stringify(entry.payload, null, 2)
                          }}</pre>
                      </dd>
                    </div>
                  </dl>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div
        v-if="totalPages > 1"
        class="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800"
      >
        <p class="text-xs text-slate-500 dark:text-slate-400">
          Page {{ page + 1 }} of {{ totalPages }}
        </p>
        <div class="flex gap-1">
          <button
            type="button"
            class="btn-secondary btn-xs"
            :disabled="!hasPrevious"
            @click="goToPage(page - 1)"
          >
            <ChevronLeft class="h-3.5 w-3.5" aria-hidden="true" />
            Newer
          </button>
          <button
            type="button"
            class="btn-secondary btn-xs"
            :disabled="!hasNext"
            @click="goToPage(page + 1)"
          >
            Older
            <ChevronRight class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
