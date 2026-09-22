<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowDown, ArrowUp, Ban, Copy, MapPin, Search, ShieldOff, UserMinus } from '@lucide/vue';
import type { EnrichedPlayer, PlayerSortKey } from '@palsentry/shared';
import { DEFAULT_ROSTER_SORT, comparePlayers, formatWorldCoordinate } from '@palsentry/shared';
import { formatDateTime, formatRelative, pingTone } from '@/lib/format';

const props = withDefaults(
  defineProps<{
    players: EnrichedPlayer[];
    /** When false, moderation buttons are rendered disabled with an explanatory tooltip. */
    destructiveAllowed: boolean;
    /** `userId` currently being actioned, so its row can show a busy state. */
    busyUserid?: string | null;
    /** Hide the search box on the dashboard, where space is tight. */
    showSearch?: boolean;
    /**
     * Offer a jump to the live map for each row. Opt-in, because only a view that owns map
     * navigation should render it — the full Players view has no map affordance.
     */
    showMapAction?: boolean;
    /**
     * Show when each player was last online, and sort by it. Opt-in: the dashboard is a live
     * view with no room for history, while the Players tab is a roster.
     */
    showLastOnline?: boolean;
    showBuildingCount?: boolean;
    showBanAction?: boolean;
    showKickAction?: boolean;
  }>(),
  {
    busyUserid: null,
    showSearch: true,
    showMapAction: false,
    showLastOnline: false,
    showBuildingCount: true,
    showBanAction: true,
    showKickAction: true,
  },
);

const emit = defineEmits<{
  kick: [player: EnrichedPlayer];
  ban: [player: EnrichedPlayer];
  unban: [player: EnrichedPlayer];
  announceTo: [player: EnrichedPlayer];
  showInMap: [player: EnrichedPlayer];
}>();

type SortKey = PlayerSortKey;

const search = ref('');
/**
 * The dashboard preview opens in the roster's recency order too; it simply has no column to show
 * or sort by, because everyone in it is online.
 */
const sortKey = ref<SortKey>(DEFAULT_ROSTER_SORT.key);
const sortAscending = ref(DEFAULT_ROSTER_SORT.ascending);
const copied = ref<string | null>(null);

/**
 * A clock for the relative labels.
 *
 * "9d ago" needs no ticking, but an idle tab in manual-refresh mode would otherwise leave
 * "2m ago" frozen on screen indefinitely. Thirty seconds is well inside the minute the label
 * rounds to, and costs one reactive update twice a minute.
 */
const now = ref(Date.now());
let ticker: number | null = null;

onMounted(() => {
  if (!props.showLastOnline) return;
  ticker = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (ticker !== null) window.clearInterval(ticker);
});

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  const list = props.players.filter((player) => {
    if (term === '') return true;
    return (
      player.name.toLowerCase().includes(term) ||
      player.accountName.toLowerCase().includes(term) ||
      player.userId.toLowerCase().includes(term) ||
      (player.ip ?? '').toLowerCase().includes(term)
    );
  });

  const sort = { key: sortKey.value, ascending: sortAscending.value };
  return [...list].sort((a, b) => comparePlayers(a, b, sort));
});

function sortBy(key: SortKey): void {
  if (sortKey.value === key) {
    sortAscending.value = !sortAscending.value;
    return;
  }
  sortKey.value = key;
  // Recency reads newest-first; every other column reads ascending.
  sortAscending.value = key !== 'lastOnline';
}

/** Exact local instant behind the relative label, for hover and screen readers. */
function lastOnlineTitle(player: EnrichedPlayer): string {
  const exact = formatDateTime(player.lastOnline);
  return player.online ? `Online now — last confirmed ${exact}` : `Last online ${exact}`;
}

/**
 * Age of a player's last session.
 *
 * Online players are not given a relative time at all: "0s ago" is noise next to a live indicator.
 */
function lastOnlineLabel(player: EnrichedPlayer): string {
  return player.online ? 'Now' : formatRelative(player.lastOnline, now.value);
}

/**
 * Ping is a property of the current session, so an offline row has none to show.
 *
 * Rendered as an em dash rather than a zeroed-out `0ms`, which would read as a perfect connection.
 */
function pingLabel(player: EnrichedPlayer): string {
  return player.online ? `${Math.round(player.ping)}ms` : '—';
}

function pingClass(player: EnrichedPlayer): string {
  return player.online ? pingTone(player.ping) : 'text-slate-400 dark:text-slate-500';
}

/** Copy an opaque id to the clipboard, confirming in the row for a moment. */
async function copy(value: string, marker: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = marker;
    setTimeout(() => {
      if (copied.value === marker) copied.value = null;
    }, 1_500);
  } catch {
    // Clipboard access needs a secure context; silently ignore rather than blocking the user.
  }
}

let COLUMNS: { key: SortKey; label: string; align: 'left' | 'right' }[] = [
  { key: 'name', label: 'Player', align: 'left' },
  { key: 'level', label: 'Level', align: 'right' },
  { key: 'ping', label: 'Ping', align: 'right' },
];

if (props.showBuildingCount) {
  COLUMNS.push({ key: 'building_count', label: 'Buildings', align: 'right' });
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="showSearch" class="relative max-w-xs">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        v-model="search"
        type="search"
        class="input pl-8"
        placeholder="Filter by name, id, or IP"
        aria-label="Filter players"
      />
    </div>

    <div class="overflow-x-auto">
      <table class="w-full border-collapse">
        <caption class="sr-only">
          {{
            showLastOnline ? 'Player roster' : 'Online players'
          }}
          with moderation actions
        </caption>
        <thead>
          <tr class="border-b border-slate-200 dark:border-slate-800">
            <th
              v-for="column in COLUMNS"
              :key="column.key"
              scope="col"
              class="table-head"
              :class="column.align === 'right' ? 'text-right' : 'text-left'"
            >
              <button
                type="button"
                class="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
                @click="sortBy(column.key)"
              >
                {{ column.label }}
                <component
                  v-if="sortKey === column.key"
                  :is="sortAscending ? ArrowUp : ArrowDown"
                  class="h-3 w-3"
                  aria-hidden="true"
                />
              </button>
            </th>
            <th scope="col" class="table-head hidden text-left lg:table-cell">Identifiers</th>
            <th scope="col" class="table-head hidden text-left sm:table-cell">Position</th>
            <th v-if="showLastOnline" scope="col" class="table-head text-left">
              <button
                type="button"
                class="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
                @click="sortBy('lastOnline')"
              >
                Last online
                <component
                  v-if="sortKey === 'lastOnline'"
                  :is="sortAscending ? ArrowUp : ArrowDown"
                  class="h-3 w-3"
                  aria-hidden="true"
                />
              </button>
            </th>
            <th scope="col" class="table-head text-right">Actions</th>
          </tr>
        </thead>

        <tbody>
          <tr
            v-for="player in filtered"
            :key="player.userId"
            class="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40"
            :class="busyUserid === player.userId ? 'opacity-60' : ''"
          >
            <td class="cell">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ player.name }}</span>
                <span
                  v-if="player.banned"
                  class="badge bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                  :title="player.banReason ?? 'Banned'"
                >
                  <Ban class="h-3 w-3" aria-hidden="true" />
                  Banned
                </span>
              </div>
              <p v-if="player.accountName" class="text-xs text-slate-500 dark:text-slate-400">
                {{ player.accountName }}
              </p>
            </td>

            <td class="cell text-right tabular-nums">{{ player.level }}</td>

            <td class="cell text-right tabular-nums">
              <span :class="pingClass(player)">{{ pingLabel(player) }}</span>
            </td>

            <td class="cell text-right tabular-nums" v-if="showBuildingCount">
              {{ player.building_count ?? '—' }}
            </td>

            <td class="cell hidden lg:table-cell">
              <div
                class="flex flex-col gap-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400"
              >
                <button
                  type="button"
                  class="inline-flex w-fit items-center gap-1 hover:text-teal-600 dark:hover:text-teal-400"
                  :title="`Copy userId ${player.userId}`"
                  @click="copy(player.userId, `userId:${player.userId}`)"
                >
                  <Copy class="h-3 w-3" aria-hidden="true" />
                  {{ copied === `userId:${player.userId}` ? 'Copied' : player.userId }}
                </button>
                <span class="text-slate-400 dark:text-slate-500">{{
                  player.online ? player.ip || 'no IP' : '—'
                }}</span>
              </div>
            </td>

            <td
              class="cell hidden font-mono text-xs text-slate-500 sm:table-cell dark:text-slate-400"
            >
              {{ formatWorldCoordinate(player.location_x) }},
              {{ formatWorldCoordinate(player.location_y) }}
            </td>

            <td
              v-if="showLastOnline"
              class="cell whitespace-nowrap"
              :title="lastOnlineTitle(player)"
            >
              <span
                v-if="player.online"
                class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
              >
                <span class="relative flex h-2 w-2" aria-hidden="true">
                  <span
                    class="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping"
                  ></span>
                  <span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                </span>
                Now
              </span>
              <span v-else class="text-xs text-slate-500 dark:text-slate-400">
                {{ lastOnlineLabel(player) }}
              </span>
            </td>

            <td class="cell">
              <div class="flex justify-end gap-1">
                <button
                  v-if="showMapAction && player.online"
                  type="button"
                  class="btn-ghost btn-xs mr-4"
                  title="Track this player on the map"
                  @click="emit('showInMap', player)"
                >
                  <MapPin class="h-3.5 w-3.5" aria-hidden="true" />
                  <span class="sr-only">Track {{ player.name }} in map</span>
                  Track in map
                </button>

                <!--                <button-->
                <!--                  type="button"-->
                <!--                  class="btn-ghost btn-xs"-->
                <!--                  :disabled="busyUserid === player.userId"-->
                <!--                  title="Send a direct message to this player"-->
                <!--                  @click="emit('announceTo', player)"-->
                <!--                >-->
                <!--                  <Megaphone class="h-3.5 w-3.5" aria-hidden="true" />-->
                <!--                  <span class="sr-only">Message {{ player.name }}</span>-->
                <!--                </button>-->

                <button
                  v-if="showKickAction && player.online"
                  type="button"
                  class="btn-secondary btn-xs mr-2"
                  :disabled="!destructiveAllowed || busyUserid === player.userId"
                  :title="
                    destructiveAllowed
                      ? `Kick ${player.name}`
                      : 'Kicking is disabled (PALSENTRY_ALLOW_DESTRUCTIVE=false)'
                  "
                  @click="emit('kick', player)"
                >
                  <UserMinus class="h-3.5 w-3.5" aria-hidden="true" />
                  Kick
                </button>

                <template v-if="showBanAction">
                  <button
                    v-if="player.banned"
                    type="button"
                    class="btn-secondary btn-xs"
                    :disabled="!destructiveAllowed || busyUserid === player.userId"
                    :title="
                      destructiveAllowed
                        ? `Unban ${player.name}`
                        : 'Unbanning is disabled (PALSENTRY_ALLOW_DESTRUCTIVE=false)'
                    "
                    @click="emit('unban', player)"
                  >
                    <ShieldOff class="h-3.5 w-3.5" aria-hidden="true" />
                    Unban
                  </button>
                  <button
                    v-else
                    type="button"
                    class="btn-danger btn-xs"
                    :disabled="!destructiveAllowed || busyUserid === player.userId"
                    :title="
                      destructiveAllowed
                        ? `Ban ${player.name}`
                        : 'Banning is disabled (PALSENTRY_ALLOW_DESTRUCTIVE=false)'
                    "
                    @click="emit('ban', player)"
                  >
                    <Ban class="h-3.5 w-3.5" aria-hidden="true" />
                    Ban
                  </button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p
      v-if="filtered.length === 0 && players.length > 0"
      class="py-4 text-center text-xs text-slate-500"
    >
      No players match “{{ search }}”.
    </p>
  </div>
</template>
