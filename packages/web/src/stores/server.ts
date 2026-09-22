import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type {
  MetaResponse,
  PlayersResponse,
  RestartStatusResponse,
  StatusResponse,
} from '@palsentry/shared';
import {
  DEFAULT_WAYBACK_INTERVAL_SECONDS,
  WAYBACK_INTERVAL_OPTIONS,
  isOnlinePlayer,
  isRestartSettled,
} from '@palsentry/shared';
import { api, errorMessage } from '@/lib/api';
import { formatInterval } from '@/lib/format';
import { useSessionStore } from './session';
import { useUiStore } from './ui';

/** Cadence for following a restart, which needs to feel live rather than merely current. */
const RESTART_POLL_MS = 1_000;

/**
 * Live server data.
 *
 * One store owns one polling loop for the whole app, so navigating between views does not
 * multiply the request rate against the game server — and so the dashboard keeps its data warm
 * while the operator is looking at, say, the audit log.
 *
 * History is deliberately *not* part of this loop. It is only needed on the Metrics view, is far
 * more expensive to summarise than a status snapshot, and has its own independent per-chart
 * filters, so `MetricsView` polls it on its own schedule.
 *
 * Polling pauses while the tab is hidden and refreshes immediately when it becomes visible again,
 * which is both kinder to the Palworld server and makes the dashboard feel instant on return.
 */
export const useServerStore = defineStore('server', () => {
  const session = useSessionStore();
  const ui = useUiStore();

  const meta = ref<MetaResponse | null>(null);
  const status = ref<StatusResponse | null>(null);
  const players = ref<PlayersResponse | null>(null);
  const restart = ref<RestartStatusResponse | null>(null);

  const lastUpdated = ref<number | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let pollTimer: number | null = null;
  let restartTimer: number | null = null;
  let inFlight = false;

  const online = computed(() => status.value?.online === true);
  const serverName = computed(() => status.value?.info?.servername ?? 'Palworld server');
  /**
   * Everyone PalSentry remembers, online or not.
   *
   * The server keeps this list even while the game server is unreachable, so the Players tab can
   * show who used to play here. Views that mean "who is connected right now" want
   * {@link onlinePlayers} instead.
   */
  const playerRoster = computed(() => players.value?.players ?? []);
  /** True when the roster was refreshed from a successful read of the game server. */
  const playerSnapshotAvailable = computed(() => players.value?.online === true);
  /** The subset of the roster that is connected right now. */
  const onlinePlayers = computed(() => playerRoster.value.filter(isOnlinePlayer));
  const playerCount = computed(() => status.value?.metrics?.currentplayernum ?? 0);
  const maxPlayers = computed(() => status.value?.metrics?.maxplayernum ?? 0);

  /** True while the capability probe has not answered yet. */
  const metaLoaded = computed(() => meta.value !== null);
  const destructiveAllowed = computed(() => meta.value?.destructiveAllowed === true);

  /**
   * How often the server records player positions.
   *
   * Server-wide rather than per-browser: recording continues while everyone has the dashboard
   * closed, which is the only way the history is worth having. `meta` is the single source of
   * truth, so a change is reflected here by patching it.
   */
  const waybackIntervalSeconds = computed(
    () => meta.value?.history.waybackIntervalSeconds ?? DEFAULT_WAYBACK_INTERVAL_SECONDS,
  );
  const waybackIntervalOptions = computed<readonly number[]>(
    () => meta.value?.history.waybackIntervalOptions ?? WAYBACK_INTERVAL_OPTIONS,
  );
  const waybackIntervalSaving = ref(false);

  /**
   * Change the recording cadence.
   *
   * Resolves true when the server accepted the value. Failures are reported as a toast and leave
   * the previous interval in force, because the selector's value is `meta`, not optimistic state:
   * there is no UI state to roll back and no chance of the header claiming a cadence the server
   * is not using.
   */
  async function updateWaybackInterval(seconds: number): Promise<boolean> {
    if (waybackIntervalSaving.value) return false;
    waybackIntervalSaving.value = true;

    try {
      const updated = await api.updateWaybackSettings({ intervalSeconds: seconds });
      if (meta.value !== null) {
        meta.value = {
          ...meta.value,
          history: {
            ...meta.value.history,
            waybackIntervalSeconds: updated.intervalSeconds,
            waybackIntervalOptions: updated.intervalOptions,
          },
        };
      }
      ui.success(
        'Recording interval updated',
        `Player positions are now recorded every ${formatInterval(updated.intervalSeconds)}.`,
      );
      return true;
    } catch (cause) {
      ui.error('Could not change the recording interval', errorMessage(cause));
      return false;
    } finally {
      waybackIntervalSaving.value = false;
    }
  }

  const restartInFlight = computed(
    () => restart.value !== null && !isRestartSettled(restart.value.state),
  );

  async function loadMeta(): Promise<void> {
    try {
      meta.value = await api.meta();
    } catch (cause) {
      error.value = errorMessage(cause);
    }
  }

  /** Fetch the live views together, keeping the shell current without per-view polling loops. */
  async function refresh(): Promise<void> {
    if (inFlight || !session.authenticated) return;
    inFlight = true;
    loading.value = true;

    try {
      const [nextStatus, nextPlayers] = await Promise.all([api.status(), api.players()]);
      status.value = nextStatus;
      players.value = nextPlayers;
      lastUpdated.value = Date.now();
      error.value = null;
    } catch (cause) {
      // A 401 is handled globally by the session store; anything else is worth surfacing.
      error.value = errorMessage(cause);
    } finally {
      inFlight = false;
      loading.value = false;
    }
  }

  async function refreshRestart(): Promise<void> {
    try {
      restart.value = await api.restartStatus();
    } catch {
      // A failed restart-status poll is not worth interrupting the operator for.
    }
  }

  /** Called after any action that changes server state, so the UI updates immediately. */
  async function refreshNow(): Promise<void> {
    await refresh();
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(): void {
    stopPolling();

    const interval = ui.pollIntervalMs;
    if (interval <= 0 || !session.authenticated) return;

    pollTimer = window.setInterval(() => {
      // Do not poll a hidden tab: nobody is reading it, and it is load the game server pays for.
      if (document.visibilityState === 'visible') void refresh();
    }, interval);
  }

  function stopRestartPolling(): void {
    if (restartTimer !== null) {
      window.clearInterval(restartTimer);
      restartTimer = null;
    }
  }

  function startRestartPolling(): void {
    stopRestartPolling();
    restartTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshRestart();
    }, RESTART_POLL_MS);
  }

  function onVisibilityChange(): void {
    if (document.visibilityState !== 'visible') return;
    // Catch up immediately instead of waiting out the remainder of the interval.
    void refresh();
    if (restartInFlight.value) void refreshRestart();
  }

  /** Start the polling loop. Called once by the app shell while authenticated. */
  async function start(): Promise<void> {
    if (!meta.value) await loadMeta();
    await Promise.all([refresh(), refreshRestart()]);
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function stop(): void {
    stopPolling();
    stopRestartPolling();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // Restart progress needs a tighter loop than the general refresh, and only while it runs.
  watch(restartInFlight, (running) => {
    if (running) startRestartPolling();
    else stopRestartPolling();
  });

  // Changing the cadence in the UI takes effect immediately.
  watch(
    () => ui.pollIntervalMs,
    () => startPolling(),
  );

  // Signing out must stop all background traffic.
  watch(
    () => session.authenticated,
    (authenticated) => {
      if (authenticated) return;
      stop();
    },
  );

  /** Clear everything on sign-out so the next operator never sees stale data. */
  function reset(): void {
    status.value = null;
    players.value = null;
    restart.value = null;
    lastUpdated.value = null;
    error.value = null;
  }

  return {
    meta,
    status,
    players,
    restart,
    lastUpdated,
    loading,
    error,
    online,
    serverName,
    playerRoster,
    playerSnapshotAvailable,
    onlinePlayers,
    playerCount,
    maxPlayers,
    metaLoaded,
    destructiveAllowed,
    waybackIntervalSeconds,
    waybackIntervalOptions,
    waybackIntervalSaving,
    updateWaybackInterval,
    restartInFlight,
    loadMeta,
    refresh,
    refreshNow,
    refreshRestart,
    start,
    stop,
    reset,
  };
});
