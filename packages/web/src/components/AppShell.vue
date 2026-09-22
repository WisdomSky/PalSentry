<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Activity,
  Ban,
  Heart,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Menu,
  Moon,
  RefreshCw,
  ScrollText,
  Settings,
  Shield,
  Sun,
  TrendingUp,
  Users,
  X,
} from '@lucide/vue';
import { useSessionStore } from '@/stores/session';
import { useServerStore } from '@/stores/server';
import { useUiStore } from '@/stores/ui';
import { formatDuration } from '@/lib/format';
import ServerStatusBadge from './ServerStatusBadge.vue';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const server = useServerStore();
const ui = useUiStore();

const mobileNavOpen = ref(false);

const NAV = [
  { name: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { name: 'players', label: 'Players', icon: Users },
  { name: 'map', label: 'Map', icon: MapIcon },
  { name: 'metrics', label: 'Metrics', icon: TrendingUp },
  { name: 'bans', label: 'Bans', icon: Ban },
  { name: 'audit', label: 'Audit log', icon: ScrollText },
  { name: 'settings', label: 'Settings', icon: Settings },
] as const;

/** A cheap tick that keeps the relative timestamp honest without rendering every frame. */
const now = ref(Date.now());

/** Relative age of the last successful poll, e.g. `12s ago`. */
const lastUpdatedLabel = computed(() => {
  if (server.lastUpdated === null) return 'never';
  const seconds = Math.max(0, Math.round((now.value - server.lastUpdated) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
});
let ticker: number | null = null;

onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now();
  }, 1_000);
});

onUnmounted(() => {
  if (ticker !== null) window.clearInterval(ticker);
});

const POLL_CHOICES = computed(() => {
  const options = server.meta?.polling.options ?? [2_000, 5_000, 15_000, 0];
  return options.map((ms) => ({
    value: ms,
    label: ms === 0 ? 'Manual' : ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`,
  }));
});

async function signOut(): Promise<void> {
  await session.logout();
  ui.info('Signed out');
  await router.push({ name: 'login' });
}

// Close the mobile drawer after navigating.
function onNavigate(): void {
  mobileNavOpen.value = false;
}
</script>

<template>
  <div class="min-h-screen bg-slate-50 dark:bg-slate-950">
    <header
      class="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90"
    >
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-3 sm:gap-3">
        <button
          type="button"
          class="btn-ghost btn-xs lg:hidden"
          :aria-expanded="mobileNavOpen"
          aria-controls="primary-navigation"
          aria-label="Toggle navigation"
          @click="mobileNavOpen = !mobileNavOpen"
        >
          <component :is="mobileNavOpen ? X : Menu" class="h-4 w-4" aria-hidden="true" />
        </button>

        <RouterLink :to="{ name: 'dashboard' }" class="flex items-center gap-2">
          <Shield class="h-5 w-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          <span class="text-sm font-semibold tracking-tight">PalSentry</span>
        </RouterLink>

        <div class="hidden min-w-0 flex-1 items-center gap-3 sm:flex">
          <span class="truncate text-xs text-slate-500 dark:text-slate-400">
            {{ server.serverName }}
          </span>
          <ServerStatusBadge
            :online="server.status === null ? null : server.online"
            :detail="server.status?.error?.message ?? null"
          />
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <span
            class="hidden text-xs text-slate-400 md:inline dark:text-slate-500"
            :title="`Last updated ${lastUpdatedLabel}`"
          >
            <Activity class="mr-1 inline h-3 w-3" aria-hidden="true" />
            {{ lastUpdatedLabel }}
          </span>

          <label class="hidden sm:block">
            <span class="sr-only">Refresh interval</span>
            <select
              class="input w-auto py-1 text-xs"
              :value="ui.pollIntervalMs"
              @change="ui.setPollInterval(Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="choice in POLL_CHOICES" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </label>

          <button
            type="button"
            class="btn-secondary btn-xs"
            :disabled="server.loading"
            title="Refresh now"
            @click="server.refreshNow()"
          >
            <RefreshCw
              class="h-3.5 w-3.5"
              :class="server.loading ? 'animate-spin' : ''"
              aria-hidden="true"
            />
            <span class="sr-only sm:not-sr-only">Refresh</span>
          </button>

          <a
            href="https://buymeacoffee.com/wisdomsky"
            class="btn-secondary btn-xs"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Donate via Buy Me a Coffee"
            title="Donate via Buy Me a Coffee (opens in a new tab)"
          >
            <Heart class="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" aria-hidden="true" />
            <span class="sr-only sm:not-sr-only">Donate</span>
          </a>

          <a
            href="https://github.com/WisdomSky/palsentry"
            class="btn-ghost btn-xs"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="PalSentry on GitHub"
            title="PalSentry on GitHub (opens in a new tab)"
          >
            <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
          </a>

          <button
            type="button"
            class="btn-ghost btn-xs"
            :aria-label="ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="ui.toggleTheme()"
          >
            <component :is="ui.theme === 'dark' ? Sun : Moon" class="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            class="btn-ghost btn-xs"
            :title="`Sign out${session.user ? ` (${session.user.username})` : ''}`"
            @click="signOut"
          >
            <LogOut class="h-4 w-4" aria-hidden="true" />
            <span class="sr-only">Sign out</span>
          </button>
        </div>
      </div>

      <!-- Desktop navigation -->
      <nav
        id="primary-navigation"
        class="mx-auto hidden max-w-7xl items-center gap-1 px-4 pb-2 lg:flex"
        aria-label="Sections"
      >
        <RouterLink
          v-for="item in NAV"
          :key="item.name"
          :to="{ name: item.name }"
          class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="
            route.name === item.name
              ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/70 dark:text-teal-300'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
          "
          :aria-current="route.name === item.name ? 'page' : undefined"
        >
          <component :is="item.icon" class="h-4 w-4" aria-hidden="true" />
          {{ item.label }}
        </RouterLink>
      </nav>
    </header>

    <!-- Mobile navigation drawer -->
    <nav
      v-if="mobileNavOpen"
      class="border-b border-slate-200 bg-white px-4 py-2 lg:hidden dark:border-slate-800 dark:bg-slate-900"
      aria-label="Sections"
    >
      <RouterLink
        v-for="item in NAV"
        :key="item.name"
        :to="{ name: item.name }"
        class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
        :class="
          route.name === item.name
            ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/70 dark:text-teal-300'
            : 'text-slate-600 dark:text-slate-300'
        "
        @click="onNavigate"
      >
        <component :is="item.icon" class="h-4 w-4" aria-hidden="true" />
        {{ item.label }}
      </RouterLink>
    </nav>

    <main class="mx-auto max-w-7xl space-y-4 px-4 py-5">
      <!-- Restart progress is global: it matters whichever view you are on. -->
      <div
        v-if="server.restartInFlight"
        class="flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-100"
        role="status"
        aria-live="polite"
      >
        <RefreshCw class="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        <div class="min-w-0">
          <p class="text-sm font-medium">Server restart in progress</p>
          <p class="truncate text-xs opacity-80">{{ server.restart?.detail }}</p>
        </div>
        <span class="ml-auto shrink-0 text-xs opacity-70">
          {{ formatDuration(server.restart?.downtimeMs ?? null) }}
        </span>
      </div>

      <RouterView />
    </main>
  </div>
</template>
