import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ConnectionStatusResponse, SessionUser } from '@palsentry/shared';
import { api, setUnauthorizedHandler } from '@/lib/api';

/**
 * Session state.
 *
 * The session cookie is httpOnly, so the browser cannot read it — the only way to know whether
 * we are signed in is to ask the server. {@link ensureLoaded} does that once and caches the
 * answer for the lifetime of the page.
 *
 * In the desktop app there is no login at all: connecting to a Palworld server *is* signing in, and
 * the server reports that through the same `MeResponse`. So this store owns both paths, and the
 * rest of the UI keeps asking one question — “is there a session?” — without caring which
 * deployment it is running in.
 */
export const useSessionStore = defineStore('session', () => {
  const user = ref<SessionUser | null>(null);
  const authenticated = ref(false);
  const loaded = ref(false);
  const pending = ref(false);
  /** Set when the session expires mid-use, so the login screen can explain why. */
  const expired = ref(false);
  /** True when the server is the desktop app, which replaces the login with a connection form. */
  const desktop = ref(false);
  /** Last known desktop connection, used to prefill the form. Null outside desktop mode. */
  const connection = ref<ConnectionStatusResponse | null>(null);

  function apply(result: {
    authenticated: boolean;
    user: SessionUser | null;
    desktop?: boolean;
  }): void {
    authenticated.value = result.authenticated;
    user.value = result.user;
    // Left untouched when the server did not say: an unreachable server must not flip the UI from
    // the connection screen to the login form.
    if (result.desktop !== undefined) desktop.value = result.desktop;
    loaded.value = true;
  }

  /** Resolve the current session once. Safe to call from every route guard. */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    await refresh();
  }

  async function refresh(): Promise<void> {
    try {
      apply(await api.me());
    } catch {
      // A failure here means the PalSentry server is unreachable, not that we are signed out.
      // Treat it as unauthenticated so the app renders the login screen rather than hanging.
      apply({ authenticated: false, user: null });
    }
  }

  async function login(username: string, password: string): Promise<void> {
    pending.value = true;
    try {
      apply(await api.login({ username, password }));
      expired.value = false;
    } finally {
      pending.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      apply({ authenticated: false, user: null });
    }
  }

  /**
   * Read the desktop connection state so the form can prefill the saved URL.
   *
   * Best-effort: a failure here must not stop the user from typing a URL, so the form stays usable
   * and the error surfaces when they press Connect.
   */
  async function loadConnection(): Promise<void> {
    if (!desktop.value) return;
    try {
      connection.value = await api.connection();
    } catch {
      connection.value = null;
    }
  }

  /**
   * Connect to a Palworld server.
   *
   * The server probes the credentials before accepting them, so a rejection here is a real one and
   * the thrown `ApiError` carries the upstream message plus per-field detail for the form.
   */
  async function connect(restUrl: string, adminPassword: string): Promise<void> {
    pending.value = true;
    try {
      connection.value = await api.connect({ restUrl, adminPassword });
      apply(await api.me());
      expired.value = false;
    } finally {
      pending.value = false;
    }
  }

  /**
   * Forget the password and stop recording.
   *
   * The remembered URL survives on the server, so reconnecting is one password away.
   */
  async function disconnect(): Promise<void> {
    try {
      connection.value = await api.disconnect();
    } finally {
      apply({ authenticated: false, user: null, desktop: true });
    }
  }

  /**
   * React to a 401 from any request.
   *
   * Without this, an expired session would leave the dashboard silently showing stale data.
   * Registered once from `main.ts`.
   */
  function installUnauthorizedHandler(onExpire: () => void): void {
    setUnauthorizedHandler(() => {
      if (!authenticated.value) return;
      authenticated.value = false;
      user.value = null;
      // Desktop mode has no session to expire: the connection was dropped, so the connection
      // screen explains the situation instead of claiming a login timed out.
      if (!desktop.value) expired.value = true;
      onExpire();
    });
  }

  return {
    user,
    authenticated,
    loaded,
    pending,
    expired,
    desktop,
    connection,
    ensureLoaded,
    refresh,
    login,
    logout,
    loadConnection,
    connect,
    disconnect,
    installUnauthorizedHandler,
  };
});
