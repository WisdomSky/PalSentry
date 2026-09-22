<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, Lock, Shield, User } from '@lucide/vue';
import { errorMessage } from '@/lib/api';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { useServerStore } from '@/stores/server';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const ui = useUiStore();
const server = useServerStore();

const username = ref('');
const password = ref('');
const error = ref<string | null>(null);

/** Set when the router bounced us here because the session expired mid-use. */
const expiredNotice = computed(() => route.query.expired === '1');

const canSubmit = computed(
  () => username.value.trim() !== '' && password.value !== '' && !session.pending,
);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  error.value = null;

  try {
    await session.login(username.value.trim(), password.value);

    // Reload capabilities now that we are authenticated, so the UI knows whether destructive
    // actions are enabled before rendering a single button.
    await server.loadMeta();

    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : null;
    await router.replace(redirect ?? { name: 'dashboard' });
    ui.success('Signed in');
  } catch (cause) {
    error.value = errorMessage(cause);
    // Never keep the password in the DOM after a failed attempt.
    password.value = '';
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
          Keep your Palworld safe. Monitor your server.
        </p>
      </div>

      <form class="card space-y-4 p-5" @submit.prevent="submit">
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
          {{ session.pending ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>

      <!--      <p class="mt-4 text-center text-xs text-slate-400 dark:text-slate-500">-->
      <!--        Credentials are configured with-->
      <!--        <code class="font-mono">PALSENTRY_LOGIN_USERNAME</code> and-->
      <!--        <code class="font-mono">PALSENTRY_LOGIN_PASSWORD_HASH</code>.-->
      <!--      </p>-->
    </div>
  </div>
</template>
