import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { useSessionStore } from './stores/session';
import { useUiStore } from './stores/ui';
import './style.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// Apply the stored theme before the first render to avoid a flash of the wrong colours.
useUiStore(pinia).initialise();

/**
 * A 401 from any request means the session expired or the secret was rotated. Bounce to the
 * login screen instead of leaving the dashboard showing stale numbers.
 *
 * In the desktop app a 401 means the Palworld connection was dropped, so the same bounce lands on
 * the connection screen — without the "session expired" query that only makes sense for a login.
 *
 * Registered here, once, rather than in each store, so exactly one handler is installed.
 */
useSessionStore(pinia).installUnauthorizedHandler(() => {
  const session = useSessionStore(pinia);
  void router.push({ name: 'login', query: session.desktop ? {} : { expired: '1' } });
});

app.use(router);
app.mount('#app');
