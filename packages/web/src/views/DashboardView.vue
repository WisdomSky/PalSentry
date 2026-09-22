<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Activity, Building2, Clock, Gauge, Server, Users } from '@lucide/vue';
import type { EnrichedPlayer } from '@palsentry/shared';
import { formatUptime, fpsTone, playerLoadPercent } from '@/lib/format';
import { useServerStore } from '@/stores/server';
import ActionPanel from '@/components/ActionPanel.vue';
import EmptyState from '@/components/EmptyState.vue';
import OfflineBanner from '@/components/OfflineBanner.vue';
import PlayerActions from '@/components/PlayerActions.vue';
import PlayerTable from '@/components/PlayerTable.vue';
import StatCard from '@/components/StatCard.vue';

const server = useServerStore();
const router = useRouter();

const metrics = computed(() => server.status?.metrics ?? null);

/**
 * Only a few rows here; the Players view has the full sortable table.
 *
 * The dashboard is a live view, so it shows who is connected right now rather than the roster —
 * a player who logged off hours ago is not part of "what is happening on the server".
 */
const PREVIEW_COUNT = 5;
const previewPlayers = computed(() => server.onlinePlayers.slice(0, PREVIEW_COUNT));
const hiddenCount = computed(() => Math.max(0, server.onlinePlayers.length - PREVIEW_COUNT));

const actions = ref<InstanceType<typeof PlayerActions> | null>(null);
const busyUserid = computed(() => actions.value?.busyUserid ?? null);

function openAction(kind: 'kick' | 'ban' | 'unban', player: EnrichedPlayer): void {
  actions.value?.open(kind, player);
}

/**
 * Hand the player over to the map as a route query.
 *
 * The stable `userId` (not the display name) keeps the link meaningful across renames, and makes
 * tracking survive a reload or a back/forward navigation.
 */
function showInMap(player: EnrichedPlayer): void {
  void router.push({ name: 'map', query: { track: player.userId } });
}

const worldGuidShort = computed(() => server.status?.info?.worldguid.slice(0, 8) ?? '');
</script>

<template>
  <div class="space-y-4">
    <OfflineBanner
      v-if="server.status !== null && !server.online"
      :message="server.status.error?.message ?? 'The Palworld server did not respond.'"
      @retry="server.refreshNow()"
    />

    <div class="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">{{ server.serverName }}</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          <span v-if="server.status?.info">
            version {{ server.status.info.version || 'unknown' }}
            <template v-if="worldGuidShort"> · world {{ worldGuidShort }}</template>
          </span>
          <span v-else>Waiting for the first status response…</span>
        </p>
      </div>
      <p
        v-if="server.status?.latencyMs !== null && server.status?.latencyMs !== undefined"
        class="text-xs text-slate-400"
      >
        <Activity class="mr-1 inline h-3 w-3" aria-hidden="true" />
        API responded in {{ server.status.latencyMs }}ms
      </p>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Players"
        :value="`${server.playerCount} / ${server.maxPlayers || '—'}`"
        :hint="`${playerLoadPercent(server.playerCount, server.maxPlayers)}% of capacity`"
      >
        <template #icon><Users class="h-4 w-4 text-slate-400" aria-hidden="true" /></template>
      </StatCard>

      <StatCard
        label="Server FPS"
        :value="metrics ? String(metrics.serverfps) : '—'"
        :hint="metrics ? `${metrics.serverframetime.toFixed(1)} ms frame time` : null"
        :tone="metrics ? fpsTone(metrics.serverfps) : undefined"
      >
        <template #icon><Gauge class="h-4 w-4 text-slate-400" aria-hidden="true" /></template>
      </StatCard>

      <StatCard
        label="Uptime"
        :value="metrics ? formatUptime(metrics.uptime) : '—'"
        :hint="metrics ? `in-game day ${metrics.days}` : null"
      >
        <template #icon><Clock class="h-4 w-4 text-slate-400" aria-hidden="true" /></template>
      </StatCard>

      <StatCard
        label="Base camps"
        :value="metrics ? String(metrics.basecampnum) : '—'"
        :hint="server.status?.info?.description || null"
      >
        <template #icon><Building2 class="h-4 w-4 text-slate-400" aria-hidden="true" /></template>
      </StatCard>
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <section class="card min-w-0 lg:col-span-2">
        <div class="card-header">
          <h2 class="card-title">Online players</h2>
          <RouterLink
            :to="{ name: 'players' }"
            class="text-xs text-teal-700 hover:underline dark:text-teal-400"
          >
            View all
          </RouterLink>
        </div>

        <EmptyState
          v-if="previewPlayers.length === 0"
          :title="server.playerSnapshotAvailable ? 'Nobody is online' : 'Server offline'"
          :description="
            server.playerSnapshotAvailable
              ? 'Players will appear here as they connect.'
              : 'Player data is unavailable while the game server is unreachable.'
          "
        >
          <template #icon>
            <Server class="h-6 w-6 text-slate-300 dark:text-slate-700" aria-hidden="true" />
          </template>
        </EmptyState>

        <div v-else class="p-4 pt-0">
          <PlayerTable
            :players="previewPlayers"
            :destructive-allowed="server.destructiveAllowed"
            :busy-userid="busyUserid"
            :show-search="false"
            :show-building-count="false"
            :show-ban-action="false"
            show-map-action
            @kick="openAction('kick', $event)"
            @ban="openAction('ban', $event)"
            @unban="openAction('unban', $event)"
            @announce-to="actions?.openAnnounceTo($event)"
            @show-in-map="showInMap($event)"
          />
          <p v-if="hiddenCount > 0" class="mt-3 text-xs text-slate-500 dark:text-slate-400">
            and {{ hiddenCount }} more —
            <RouterLink
              :to="{ name: 'players' }"
              class="text-teal-700 hover:underline dark:text-teal-400"
            >
              see all players
            </RouterLink>
          </p>
        </div>
      </section>

      <ActionPanel class="min-w-0" />
    </div>

    <PlayerActions ref="actions" />
  </div>
</template>
