<script setup lang="ts">
import { computed, ref } from 'vue';
import { Ban, RefreshCw, ShieldOff, Trash2 } from '@lucide/vue';
import type { BanRecord } from '@palsentry/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { usePolling } from '@/composables/usePolling';
import { useServerStore } from '@/stores/server';
import { useUiStore } from '@/stores/ui';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';

const server = useServerStore();
const ui = useUiStore();

const bans = ref<BanRecord[]>([]);
const loading = ref(true);
const unbanTarget = ref<BanRecord | null>(null);
const deleteTarget = ref<BanRecord | null>(null);
const busy = ref(false);

/** Manual unban by id, for bans issued before PalSentry existed or from the in-game console. */
const manualUserid = ref('');
const manualUnbanTarget = ref<string | null>(null);
const manualBusy = ref(false);

/**
 * The bans list is PalSentry's own registry, which only changes when someone acts, so it is
 * polled slowly rather than on the dashboard's cadence.
 */
const { run: reload } = usePolling(
  async () => {
    try {
      bans.value = (await api.bans()).bans;
    } catch (error) {
      ui.error('Could not load bans', errorMessage(error));
    } finally {
      loading.value = false;
    }
  },
  { intervalMs: 30_000 },
);

const activeBans = computed(() => bans.value.filter((ban) => ban.active));
const pastBans = computed(() => bans.value.filter((ban) => !ban.active));

async function unban(): Promise<void> {
  const target = unbanTarget.value;
  if (target === null) return;

  busy.value = true;
  try {
    await api.unban({ userid: target.userid });
    ui.success(`Unbanned ${target.playerName ?? target.userid}`);
    unbanTarget.value = null;
    await reload();
    await server.refreshNow();
  } catch (error) {
    ui.error('Unban failed', errorMessage(error));
  } finally {
    busy.value = false;
  }
}

function requestManualUnban(): void {
  const userid = manualUserid.value.trim();
  if (userid !== '') manualUnbanTarget.value = userid;
}

async function unbanByUserid(): Promise<void> {
  const userid = manualUnbanTarget.value;
  if (userid === null) return;

  manualBusy.value = true;
  try {
    await api.unban({ userid });
    ui.success('Player unbanned', userid);
    manualUserid.value = '';
    manualUnbanTarget.value = null;
    await reload();
    await server.refreshNow();
  } catch (error) {
    ui.error('Unban failed', errorMessage(error));
  } finally {
    manualBusy.value = false;
  }
}

/** Forget a registry row. Deliberately does *not* unban anyone — the dialog says so. */
async function forget(): Promise<void> {
  const target = deleteTarget.value;
  if (target === null) return;

  busy.value = true;
  try {
    await api.deleteBan(target.id);
    ui.success('Registry entry removed');
    deleteTarget.value = null;
    await reload();
  } catch (error) {
    ui.error('Could not remove entry', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">Bans</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          {{ activeBans.length }} active · {{ pastBans.length }} lifted
        </p>
      </div>
      <button type="button" class="btn-secondary btn-xs" @click="reload()">
        <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        Refresh
      </button>
    </div>

    <!--    <div-->
    <!--      class="rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"-->
    <!--      role="note"-->
    <!--    >-->
    <!--      <p>-->
    <!--        The Palworld REST API can ban and unban but has-->
    <!--        <strong>no endpoint that lists bans</strong>. This is PalSentry's own record, so it shows-->
    <!--        bans issued through PalSentry — bans made from the in-game console or before PalSentry was-->
    <!--        installed will not appear. Unban those by pasting the player id below.-->
    <!--      </p>-->
    <!--    </div>-->

    <!-- Manual unban -->
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">Unban by player id</h2>
      </div>
      <form class="flex flex-wrap gap-2 p-4 pt-3" @submit.prevent="requestManualUnban">
        <input
          v-model="manualUserid"
          class="input flex-1 font-mono text-xs"
          placeholder="Player userid (from the in-game admin list or banlist.txt)"
          :disabled="manualBusy || !server.destructiveAllowed"
          aria-label="Player userid to unban"
        />
        <button
          type="submit"
          class="btn-secondary"
          :disabled="manualBusy || manualUserid.trim() === '' || !server.destructiveAllowed"
          :title="
            server.destructiveAllowed ? undefined : 'Disabled by PALSENTRY_ALLOW_DESTRUCTIVE=false'
          "
        >
          <ShieldOff class="h-4 w-4" aria-hidden="true" />
          Unban
        </button>
      </form>
    </section>

    <!-- Active bans -->
    <section class="card">
      <div class="card-header">
        <h2 class="card-title">Active bans</h2>
      </div>

      <EmptyState v-if="loading && bans.length === 0" title="Loading bans…" />
      <EmptyState
        v-else-if="activeBans.length === 0"
        title="No active bans"
        description="Bans you issue through PalSentry will be listed here with their reason and history."
      >
        <template #icon
          ><Ban class="h-6 w-6 text-slate-300 dark:text-slate-700" aria-hidden="true"
        /></template>
      </EmptyState>

      <div v-else class="overflow-x-auto p-4 pt-0">
        <table class="w-full border-collapse">
          <caption class="sr-only">
            Currently banned players
          </caption>
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800">
              <th scope="col" class="table-head">Player</th>
              <th scope="col" class="table-head">Reason</th>
              <th scope="col" class="table-head">Banned</th>
              <th scope="col" class="table-head hidden lg:table-cell">By</th>
              <th scope="col" class="table-head text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ban in activeBans"
              :key="ban.id"
              class="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
            >
              <td class="cell">
                <p class="font-medium">{{ ban.playerName ?? 'Unknown player' }}</p>
                <p class="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {{ ban.userid }}
                </p>
              </td>
              <td class="cell max-w-xs truncate" :title="ban.reason ?? undefined">
                {{ ban.reason ?? '—' }}
              </td>
              <td class="cell">
                <span :title="formatDateTime(ban.bannedAt)">{{
                  formatRelative(ban.bannedAt)
                }}</span>
              </td>
              <td class="cell hidden lg:table-cell text-xs text-slate-500 dark:text-slate-400">
                {{ ban.actorName ?? '—' }}
                <span v-if="ban.actorIp" class="block font-mono text-[11px]">{{
                  ban.actorIp
                }}</span>
              </td>
              <td class="cell">
                <div class="flex justify-end gap-1">
                  <button
                    type="button"
                    class="btn-secondary btn-xs"
                    :disabled="!server.destructiveAllowed"
                    :title="
                      server.destructiveAllowed
                        ? 'Lift this ban'
                        : 'Disabled by PALSENTRY_ALLOW_DESTRUCTIVE=false'
                    "
                    @click="unbanTarget = ban"
                  >
                    <ShieldOff class="h-3.5 w-3.5" aria-hidden="true" />
                    Unban
                  </button>
                  <button
                    type="button"
                    class="btn-ghost btn-xs"
                    title="Remove this registry entry (does not unban the player)"
                    @click="deleteTarget = ban"
                  >
                    <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                    <span class="sr-only">Remove entry</span>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- History -->
    <section v-if="pastBans.length > 0" class="card">
      <div class="card-header">
        <h2 class="card-title">Lifted bans</h2>
      </div>
      <div class="overflow-x-auto p-4 pt-0">
        <table class="w-full border-collapse">
          <caption class="sr-only">
            Previously banned players
          </caption>
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-800">
              <th scope="col" class="table-head">Player</th>
              <th scope="col" class="table-head">Reason</th>
              <th scope="col" class="table-head">Banned</th>
              <th scope="col" class="table-head">Lifted</th>
              <th scope="col" class="table-head text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ban in pastBans"
              :key="ban.id"
              class="border-b border-slate-100 text-slate-500 last:border-0 dark:border-slate-800/60 dark:text-slate-400"
            >
              <td class="cell">
                <p>{{ ban.playerName ?? 'Unknown player' }}</p>
                <p class="font-mono text-[11px]">{{ ban.userid }}</p>
              </td>
              <td class="cell max-w-xs truncate">{{ ban.reason ?? '—' }}</td>
              <td class="cell" :title="formatDateTime(ban.bannedAt)">
                {{ formatRelative(ban.bannedAt) }}
              </td>
              <td class="cell" :title="formatDateTime(ban.unbannedAt)">
                {{ formatRelative(ban.unbannedAt) }}
              </td>
              <td class="cell text-right">
                <button
                  type="button"
                  class="btn-ghost btn-xs"
                  title="Remove this registry entry"
                  @click="deleteTarget = ban"
                >
                  <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <ConfirmDialog
      :open="manualUnbanTarget !== null"
      title="Unban this player id?"
      confirm-label="Unban"
      :busy="manualBusy"
      @cancel="manualUnbanTarget = null"
      @confirm="unbanByUserid"
    >
      <p>This asks the Palworld server to lift the ban for:</p>
      <p class="rounded bg-slate-100 px-2 py-1 font-mono text-xs dark:bg-slate-800">
        {{ manualUnbanTarget }}
      </p>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        PalSentry cannot verify this id first because the REST API has no endpoint that lists bans.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :open="unbanTarget !== null"
      title="Lift this ban?"
      confirm-label="Unban"
      :busy="busy"
      @cancel="unbanTarget = null"
      @confirm="unban"
    >
      <p>
        <strong>{{ unbanTarget?.playerName ?? unbanTarget?.userid }}</strong> will be allowed to
        rejoin the server.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="Remove this registry entry?"
      tone="danger"
      confirm-label="Remove"
      :busy="busy"
      @cancel="deleteTarget = null"
      @confirm="forget"
    >
      <p>
        This only deletes PalSentry's record. <strong>It does not unban the player</strong> — use
        Unban for that.
      </p>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        The deletion is itself recorded in the audit log.
      </p>
    </ConfirmDialog>
  </div>
</template>
