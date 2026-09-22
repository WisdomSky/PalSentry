import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useSessionStore } from './stores/session';

/**
 * Client-side routes.
 *
 * Every view is lazily imported so the initial bundle only contains the shell and the login
 * screen — the dashboard, audit table, and settings browser load on demand.
 *
 * `meta.public` marks the routes reachable without a session. The guard below is the *only*
 * thing deciding access, and it denies by default, so adding a route without thinking about
 * auth yields a protected route rather than an open one.
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { public: true, title: 'Sign in' },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('./views/DashboardView.vue'),
    meta: { title: 'Dashboard' },
  },
  {
    path: '/players',
    name: 'players',
    component: () => import('./views/PlayersView.vue'),
    meta: { title: 'Players' },
  },
  {
    path: '/map',
    name: 'map',
    component: () => import('./views/MapView.vue'),
    meta: { title: 'Map' },
  },
  {
    path: '/metrics',
    name: 'metrics',
    component: () => import('./views/MetricsView.vue'),
    meta: { title: 'Metrics' },
  },
  {
    path: '/bans',
    name: 'bans',
    component: () => import('./views/BansView.vue'),
    meta: { title: 'Bans' },
  },
  {
    path: '/audit',
    name: 'audit',
    component: () => import('./views/AuditView.vue'),
    meta: { title: 'Audit log' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./views/SettingsView.vue'),
    meta: { title: 'Settings' },
  },
  // Any unknown path falls back to the dashboard rather than 404-ing inside the SPA.
  { path: '/:pathMatch(.*)*', redirect: { name: 'dashboard' } },
];

export const router = createRouter({
  // History mode: requires the server's SPA fallback, which `buildApp` provides.
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  // Resolves the session cookie once per page load, then serves the cached answer.
  await session.ensureLoaded();

  const isPublic = to.meta.public === true;

  if (!isPublic && !session.authenticated) {
    return {
      name: 'login',
      // Remember where they were headed so sign-in can return them there.
      query: to.fullPath === '/' ? {} : { redirect: to.fullPath },
    };
  }

  if (isPublic && session.authenticated) {
    return { name: 'dashboard' };
  }

  return true;
});

router.afterEach((to) => {
  const session = useSessionStore();
  // The desktop app has no login to sign in to, so the connection screen titles itself
  // accordingly — this string is the OS window/tab title the user is looking at.
  const title =
    to.name === 'login' && session.desktop
      ? 'Connect'
      : typeof to.meta.title === 'string'
        ? to.meta.title
        : null;

  document.title = title === null ? 'PalSentry' : `${title} · PalSentry`;
});
