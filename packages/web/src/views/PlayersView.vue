<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertTriangle, RefreshCw, Server, ShieldAlert, Users } from '@lucide/vue';
import type { EnrichedPlayer } from '@palsentry/shared';
import { formatInterval, formatUptime } from '@/lib/format';
import { useServerStore } from '@/stores/server';
import EmptyState from '@/components/EmptyState.vue';
import OfflineBanner from '@/components/OfflineBanner.vue';
import PlayerActions from '@/components/PlayerActions.vue';
import PlayerTable from '@/components/PlayerTable.vue';
import { useRouter } from 'vue-router';

const server = useServerStore();
const router = useRouter();

const actions = ref<InstanceType<typeof PlayerActions> | null>(null);
const busyUserid = computed(() => actions.value?.busyUserid ?? null);

/** Bans are account-level, so this counts the whole roster rather than only who is online. */
const bannedKnown = computed(() => server.playerRoster.filter((player) => player.banned).length);
const totalBuildings = computed(() =>
  server.onlinePlayers.reduce((sum, player) => sum + player.building_count, 0),
);
/** Players the roster remembers who are not connected right now. */
const offlineCount = computed(() => server.playerRoster.length - server.onlinePlayers.length);

function openAction(kind: 'kick' | 'ban' | 'unban', player: EnrichedPlayer): void {
  actions.value?.open(kind, player);
}

function showInMap(player: EnrichedPlayer): void {
  void router.push({ name: 'map', query: { track: player.userId } });
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">Players</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          <template v-if="server.playerSnapshotAvailable">
            {{ server.onlinePlayers.length }} online
            <template v-if="server.maxPlayers"> of {{ server.maxPlayers }} </template>
            <template v-if="offlineCount > 0"> · {{ offlineCount }} offline </template>
            · {{ totalBuildings }} buildings placed
            <template v-if="bannedKnown > 0">
              · <span class="text-rose-600 dark:text-rose-400">{{ bannedKnown }} banned</span>
            </template>
          </template>
          <template v-else-if="server.playerRoster.length > 0">
            Live player data is unavailable — showing the last known roster.
          </template>
          <template v-else>Live player data is unavailable.</template>
          <template v-if="server.status?.metrics">
            · server up {{ formatUptime(server.status.metrics.uptime) }}
          </template>
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <p
          class="text-xs text-slate-500 dark:text-slate-400"
          title="Recording continues while no dashboard is open. Change it with the PALSENTRY_WAYBACK_INTERVAL_SECONDS environment variable."
        >
          Recording positions every {{ formatInterval(server.waybackIntervalSeconds) }}
        </p>

        <button
          type="button"
          class="btn-secondary btn-xs"
          :disabled="server.loading"
          @click="server.refreshNow()"
        >
          <RefreshCw
            class="h-3.5 w-3.5"
            :class="server.loading ? 'animate-spin' : ''"
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>
    </div>

    <OfflineBanner
      v-if="server.status !== null && !server.online"
      :message="server.status.error?.message ?? 'The Palworld server did not respond.'"
      @retry="server.refreshNow()"
    />

    <div
      v-if="!server.destructiveAllowed"
      class="flex items-start gap-2 rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
      role="note"
    >
      <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Moderation actions are disabled because
        <code class="font-mono">PALSENTRY_ALLOW_DESTRUCTIVE</code> is not
        <code class="font-mono">true</code>. Broadcasting and saving still work.
      </span>
    </div>

    <section class="card">
      <div class="card-header">
        <h2 class="card-title">Known players</h2>
        <span class="text-xs text-slate-500 dark:text-slate-400">
          Everyone who has played here. Locations are raw world coordinates.
        </span>
      </div>

      <p
        v-if="!server.playerSnapshotAvailable && server.playerRoster.length > 0"
        class="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        role="note"
      >
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          The game server did not answer, so nobody can be confirmed online. Last known positions
          and times are still shown.
        </span>
      </p>

      <EmptyState
        v-if="server.playerRoster.length === 0"
        :title="server.playerSnapshotAvailable ? 'Nobody has played yet' : 'Server offline'"
        :description="
          server.playerSnapshotAvailable
            ? 'Players are remembered here from their first connection, and stay after they leave.'
            : 'Start the Palworld server, or check PALWORLD_REST_URL and that RESTAPIEnabled=True.'
        "
      >
        <template #icon>
          <component
            :is="server.playerSnapshotAvailable ? Users : Server"
            class="h-6 w-6 text-slate-300 dark:text-slate-700"
            aria-hidden="true"
          />
        </template>
      </EmptyState>

      <div v-else class="p-4 pt-0">
        <PlayerTable
          :players="server.playerRoster"
          :destructive-allowed="server.destructiveAllowed"
          :busy-userid="busyUserid"
          :show-map-action="true"
          show-last-online
          @kick="openAction('kick', $event)"
          @ban="openAction('ban', $event)"
          @unban="openAction('unban', $event)"
          @announce-to="actions?.openAnnounceTo($event)"
          @show-in-map="showInMap($event)"
        />
      </div>
    </section>

    <PlayerActions ref="actions" />
  </div>
</template>
