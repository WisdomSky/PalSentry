<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { PowerOff, RotateCcw, Save, Send } from '@lucide/vue';
import { api, errorMessage } from '@/lib/api';
import { useServerStore } from '@/stores/server';
import { useUiStore } from '@/stores/ui';
import ConfirmDialog from './ConfirmDialog.vue';

const server = useServerStore();
const ui = useUiStore();

const broadcastMessage = ref('');
const broadcastBusy = ref(false);
const saveBusy = ref(false);

const shutdownWait = ref(30);
const shutdownMessage = ref('');
const restartWait = ref(30);
const restartMessage = ref('');

/** Which confirmation dialog is open, if any. */
const pending = ref<'shutdown' | 'stop' | 'restart' | null>(null);
const confirmBusy = ref(false);

const destructiveAllowed = computed(() => server.destructiveAllowed);
const blockedReason = 'Disabled by PALSENTRY_ALLOW_DESTRUCTIVE=false';

/** Default the countdowns to whatever the deployment configured. */
const defaultWait = computed(() => server.meta?.restart.defaultWaitSeconds ?? 30);

watch(
  defaultWait,
  (waittime) => {
    shutdownWait.value = waittime;
    restartWait.value = waittime;
  },
  { immediate: true },
);

/**
 * Run an action and report the outcome; returns true on success.
 *
 * The callback returns the message to show, which is why callers unwrap the API response rather
 * than the helper doing it — `restart` responds with a status object and no message of its own.
 */
async function run(label: string, action: () => Promise<string>): Promise<boolean> {
  try {
    const message = await action();
    ui.success(message === '' ? label : message);
    await server.refreshNow();
    return true;
  } catch (error) {
    ui.error(`${label} failed`, errorMessage(error));
    return false;
  }
}

async function sendBroadcast(): Promise<void> {
  const message = broadcastMessage.value.trim();
  if (message === '') return;

  broadcastBusy.value = true;
  try {
    const sent = await run('Broadcast', async () => (await api.announce({ message })).message);
    if (sent) broadcastMessage.value = '';
  } finally {
    broadcastBusy.value = false;
  }
}

async function saveWorld(): Promise<void> {
  saveBusy.value = true;
  try {
    await run('Save world', async () => (await api.save()).message);
  } finally {
    saveBusy.value = false;
  }
}

async function confirmPending(): Promise<void> {
  const which = pending.value;
  if (which === null) return;

  confirmBusy.value = true;
  try {
    let succeeded: boolean;

    if (which === 'shutdown') {
      const message = shutdownMessage.value.trim();
      succeeded = await run(
        'Shutdown',
        async () =>
          (
            await api.shutdown({
              waittime: shutdownWait.value,
              ...(message === '' ? {} : { message }),
            })
          ).message,
      );
    } else if (which === 'stop') {
      succeeded = await run('Force stop', async () => (await api.stop()).message);
    } else {
      const message = restartMessage.value.trim();
      succeeded = await run('Restart', async () => {
        const status = await api.restart({
          waittime: restartWait.value,
          ...(message === '' ? {} : { message }),
        });
        return `Restart started (${status.waittimeSeconds}s warning) — watching for the server to come back.`;
      });
      if (succeeded) await server.refreshRestart();
    }

    // Keep a failed action open so the operator can correct its inputs or retry.
    if (succeeded) pending.value = null;
  } finally {
    confirmBusy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <div class="card-header">
      <h2 class="card-title">Server actions</h2>
      <span
        v-if="!destructiveAllowed"
        class="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
        title="Set PALSENTRY_ALLOW_DESTRUCTIVE=true to enable moderation, shutdown, and restart"
      >
        Read-only mode
      </span>
    </div>

    <div class="space-y-5 p-4">
      <!-- Broadcast -->
      <form class="space-y-2" @submit.prevent="sendBroadcast">
        <label class="label" for="broadcast">Broadcast a message:</label>
        <div class="flex gap-2">
          <input
            id="broadcast"
            v-model="broadcastMessage"
            class="input"
            maxlength="200"
            placeholder="Server restarting in 10 minutes"
            :disabled="broadcastBusy"
          />
          <button
            type="submit"
            class="btn-primary shrink-0"
            :disabled="broadcastBusy || broadcastMessage.trim() === ''"
          >
            <Send class="h-4 w-4" aria-hidden="true" />
            Send
          </button>
        </div>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          Sends a global message that appears in every player's chat.
        </p>
      </form>

      <hr class="border-slate-200 dark:border-slate-800" />

      <!-- Save -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p class="text-sm font-medium">Save Server</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Manually trigger the autosave routine.
          </p>
        </div>
        <button type="button" class="btn-secondary" :disabled="saveBusy" @click="saveWorld">
          <Save class="h-4 w-4" aria-hidden="true" />
          {{ saveBusy ? 'Saving…' : 'Save now' }}
        </button>
      </div>

      <hr class="border-slate-200 dark:border-slate-800" />

      <!-- Restart -->
      <div class="space-y-2">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p class="text-sm font-medium">Restart the server</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Announces to all players that the system will be restarting the server.
            </p>
          </div>
          <button
            type="button"
            class="btn-primary"
            :disabled="!destructiveAllowed || server.restartInFlight"
            :title="destructiveAllowed ? undefined : blockedReason"
            @click="pending = 'restart'"
          >
            <RotateCcw class="h-4 w-4" aria-hidden="true" />
            Restart Server
          </button>
        </div>
      </div>

      <!-- Shutdown / stop -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p class="text-sm font-medium">Graceful shutdown</p>
          <div class="flex gap-2 flex-col">
            <label class="label mb-0 shrink-0" for="shutdown-wait">Warning Countdown:</label>
            <span>
              <input
                id="shutdown-wait"
                v-model.number="shutdownWait"
                class="input w-20 py-1 text-sm"
                type="number"
                min="0"
                max="3600"
              />&nbsp;<span class="text-xs text-slate-500 dark:text-slate-400">seconds</span>
            </span>
          </div>
          <button
            type="button"
            class="btn-secondary w-full"
            :disabled="!destructiveAllowed"
            :title="destructiveAllowed ? undefined : blockedReason"
            @click="pending = 'shutdown'"
          >
            <PowerOff class="h-4 w-4" aria-hidden="true" />
            Shut down
          </button>
        </div>

        <div class="space-y-2 rounded-lg border border-rose-200 p-3 dark:border-rose-900/50">
          <p class="text-sm font-medium text-rose-700 dark:text-rose-300">Force stop</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Kills the process immediately. No save, no warning.
          </p>
          <button
            type="button"
            class="btn-danger w-full"
            :disabled="!destructiveAllowed"
            :title="destructiveAllowed ? undefined : blockedReason"
            @click="pending = 'stop'"
          >
            <PowerOff class="h-4 w-4" aria-hidden="true" />
            Force stop
          </button>
        </div>
      </div>
    </div>

    <!-- Shutdown confirmation -->
    <ConfirmDialog
      :open="pending === 'shutdown'"
      title="Shut down the server?"
      tone="danger"
      confirm-label="Shut down"
      :busy="confirmBusy"
      @cancel="pending = null"
      @confirm="confirmPending"
    >
      <p>
        The server will stop in <strong>{{ shutdownWait }} seconds</strong>. Nothing will start it
        again unless its container has
        <code class="font-mono text-xs">restart: unless-stopped</code>.
      </p>
      <div>
        <label class="label" for="shutdown-message">Message to players (optional)</label>
        <input
          id="shutdown-message"
          v-model="shutdownMessage"
          class="input"
          maxlength="200"
          placeholder="Server going down for maintenance"
        />
      </div>
    </ConfirmDialog>

    <!-- Force stop confirmation -->
    <ConfirmDialog
      :open="pending === 'stop'"
      title="Force stop the server?"
      tone="danger"
      confirm-label="Force stop"
      :busy="confirmBusy"
      @cancel="pending = null"
      @confirm="confirmPending"
    >
      <p>
        This kills the process immediately.
        <strong>Any unsaved progress since the last save is lost.</strong> Save the world first if
        you can.
      </p>
    </ConfirmDialog>

    <!-- Restart confirmation -->
    <ConfirmDialog
      :open="pending === 'restart'"
      title="Restart the server?"
      confirm-label="Restart"
      :busy="confirmBusy"
      @cancel="pending = null"
      @confirm="confirmPending"
    >
      <p>
        Palsentry will announce the restart, save the world, and shut the server down. It then waits
        for the container to come back online.
      </p>
      <div class="flex items-center gap-2">
        <label class="label mb-0 shrink-0" for="restart-wait">Warning</label>
        <input
          id="restart-wait"
          v-model.number="restartWait"
          class="input w-20 py-1 text-sm"
          type="number"
          min="0"
          max="3600"
        />
        <span class="text-xs text-slate-500 dark:text-slate-400">seconds</span>
      </div>
      <div>
        <label class="label" for="restart-message">Message to players (optional)</label>
        <input
          id="restart-message"
          v-model="restartMessage"
          class="input"
          maxlength="200"
          placeholder="Server restarting — back in a minute!"
        />
      </div>
    </ConfirmDialog>
  </section>
</template>
