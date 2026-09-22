import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SessionUser } from '@palsentry/shared';
import { api, setUnauthorizedHandler } from '@/lib/api';

/**
 * Session state.
 *
 * The session cookie is httpOnly, so the browser cannot read it — the only way to know whether
 * we are signed in is to ask the server. {@link ensureLoaded} does that once and caches the
 * answer for the lifetime of the page.
 */
export const useSessionStore = defineStore('session', () => {
  const user = ref<SessionUser | null>(null);
  const authenticated = ref(false);
  const loaded = ref(false);
  const pending = ref(false);
  /** Set when the session expires mid-use, so the login screen can explain why. */
  const expired = ref(false);

  function apply(result: { authenticated: boolean; user: SessionUser | null }): void {
    authenticated.value = result.authenticated;
    user.value = result.user;
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
      // A failure here means the Palsentry server is unreachable, not that we are signed out.
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
      expired.value = true;
      onExpire();
    });
  }

  return {
    user,
    authenticated,
    loaded,
    pending,
    expired,
    ensureLoaded,
    refresh,
    login,
    logout,
    installUnauthorizedHandler,
  };
});
