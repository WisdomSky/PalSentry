<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, Globe, Lock, Shield, User } from '@lucide/vue';
import { ApiError, errorMessage } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { useServerStore } from '@/stores/server';

/**
 * The one screen that stands between an unauthenticated visitor and the dashboard.
 *
 * It has two variants, decided by the server:
 *
 * - **Container deployment** — username and password for the PalSentry login.
 * - **Desktop app** — the Palworld REST URL and admin password. There is no PalSentry account: the
 *   password is probed against the game server, kept in memory for this session, and never stored.
 */
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const ui = useUiStore();
const server = useServerStore();

const username = ref('');
const password = ref('');

/** Desktop connection fields. */
const restUrl = ref('');
const adminPassword = ref('');

const error = ref<string | null>(null);
/** Per-field messages from the API, keyed by request field. */
const fieldErrors = ref<Record<string, string>>({});

const desktop = computed(() => session.desktop);

/** Set when the router bounced us here because the session expired mid-use. */
const expiredNotice = computed(() => route.query.expired === '1' && !desktop.value);

const pending = computed(() => session.pending);

const canSubmit = computed(() => {
  if (pending.value) return false;
  if (desktop.value) return restUrl.value.trim() !== '' && adminPassword.value !== '';
  return username.value.trim() !== '' && password.value !== '';
});

// The on-screen hint mirrors what the server will accept: it normalises a bare `host:port` and
// appends `/v1/api` itself, so telling the user to include the API path would be wrong.
const urlPlaceholder = 'http://192.168.1.50:8212';

onMounted(async () => {
  if (!desktop.value) return;

  // Prefill the saved URL so reconnecting is one password away.
  await session.loadConnection();
  if (session.connection?.restUrl) restUrl.value = session.connection.restUrl;
});

/** Clear the password fields after any failure: never keep a credential in the DOM. */
function reset(): void {
  adminPassword.value = '';
  password.value = '';
}

function applyFailure(cause: unknown): void {
  error.value = errorMessage(cause);
  fieldErrors.value = cause instanceof ApiError && cause.fields !== undefined ? cause.fields : {};
  reset();
}

async function connect(): Promise<void> {
  if (!canSubmit.value) return;
  error.value = null;
  fieldErrors.value = {};

  try {
    await session.connect(restUrl.value.trim(), adminPassword.value);

    // Reload capabilities now that we are authenticated, so the UI knows whether destructive
    // actions are enabled before rendering a single button.
    await server.loadMeta();

    await router.replace({ name: 'dashboard' });
    ui.success('Connected to the Palworld server');
  } catch (cause) {
    applyFailure(cause);
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  error.value = null;
  fieldErrors.value = {};

  try {
    await session.login(username.value.trim(), password.value);

    await server.loadMeta();

    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : null;
    await router.replace(redirect ?? { name: 'dashboard' });
    ui.success('Signed in');
  } catch (cause) {
    applyFailure(cause);
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4 dark:bg-slate-950">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center gap-2 text-center">
        <Shield class="h-8 w-8 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        <h1 class="text-lg font-semibold tracking-tight">PalSentry</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          {{
            desktop
              ? 'Connect to your Palworld server to start monitoring.'
              : 'Keep your Palworld safe. Monitor your server.'
          }}
        </p>
      </div>

      <form class="card space-y-4 p-5" @submit.prevent="desktop ? connect() : submit()">
        <div
          v-if="expiredNotice"
          class="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-100"
          role="status"
        >
          <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Your session expired. Sign in again to continue.</span>
        </div>

        <div
          v-if="error"
          class="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-100"
          role="alert"
        >
          {{ error }}
        </div>

        <!-- Desktop: point the app at a Palworld server. -->
        <template v-if="desktop">
          <div>
            <label class="label" for="rest-url">Palworld REST URL</label>
            <div class="relative">
              <Globe
                class="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="rest-url"
                v-model="restUrl"
                class="input pl-8"
                :placeholder="urlPlaceholder"
                inputmode="url"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                aria-describedby="rest-url-hint"
                required
              />
            </div>
            <p
              v-if="fieldErrors.restUrl"
              class="mt-1 text-xs text-rose-600 dark:text-rose-400"
              role="alert"
            >
              {{ fieldErrors.restUrl }}
            </p>
            <p id="rest-url-hint" class="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Host and REST API port of your Palworld server.
            </p>
          </div>

          <div>
            <label class="label" for="admin-password">Admin password</label>
            <div class="relative">
              <Lock
                class="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="admin-password"
                v-model="adminPassword"
                placeholder="AdminPassword from PalWorldSettings.ini"
                type="password"
                class="input pl-8"
                autocomplete="off"
                aria-describedby="admin-password-hint"
                required
              />
            </div>
            <p
              v-if="fieldErrors.adminPassword"
              class="mt-1 text-xs text-rose-600 dark:text-rose-400"
              role="alert"
            >
              {{ fieldErrors.adminPassword }}
            </p>
            <p id="admin-password-hint" class="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Used for this session only — never saved. You will be asked again next launch.
            </p>
          </div>

          <button type="submit" class="btn-primary w-full" :disabled="!canSubmit">
            {{ pending ? 'Connecting…' : 'Connect' }}
          </button>
        </template>

        <!-- Container deployment: the PalSentry login, unchanged. -->
        <template v-else>
          <div>
            <label class="label" for="username">Username</label>
            <div class="relative">
              <User
                class="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="username"
                v-model="username"
                class="input pl-8"
                autocomplete="username"
                placeholder="Username"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                required
              />
            </div>
          </div>

          <div>
            <label class="label" for="password">Password</label>
            <div class="relative">
              <Lock
                class="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="password"
                v-model="password"
                placeholder="Password"
                type="password"
                class="input pl-8"
                autocomplete="current-password"
                required
              />
            </div>
          </div>

          <button type="submit" class="btn-primary w-full" :disabled="!canSubmit">
            {{ pending ? 'Signing in…' : 'Sign in' }}
          </button>
        </template>
      </form>

      <!--      <p class="mt-4 text-center text-xs text-slate-400 dark:text-slate-500">-->
      <!--        Credentials are configured with-->
      <!--        <code class="font-mono">PALSENTRY_LOGIN_USERNAME</code> and-->
      <!--        <code class="font-mono">PALSENTRY_LOGIN_PASSWORD_HASH</code>.-->
      <!--      </p>-->
    </div>
  </div>
</template>
