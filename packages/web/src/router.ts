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
  /**
   * Where the page should be after a navigation.
   *
   * The case that matters day to day is the second one: the wayback timeline writes the instant it
   * is replaying into the URL once a second, and that is a navigation like any other. Scrolling to
   * the top for it would throw the operator out of the view they scrolled to — on a small screen,
   * out of the map they are watching — once per second.
   *
   * Restoring a scroll position for back/forward is deliberately not attempted: every view mounts
   * its content asynchronously, so at the moment this runs the document is still viewport-height
   * and any position below the top is clamped away. Landing at the top is the honest result until
   * the views reserve the room they are going to fill.
   */
  scrollBehavior: (to, from) => {
    // A query change is state inside the view already on screen — the replayed instant, a range, a
    // tracked player — rather than a move between views, so it leaves the operator where they are.
    if (to.path === from.path) return false;
    // Landing on a different page still starts at its top.
    return { top: 0 };
  },
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
