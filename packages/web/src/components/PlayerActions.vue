<script setup lang="ts">
import { computed } from 'vue';
import { PLAYER_ACTION_TITLES, usePlayerActions } from '@/composables/usePlayerActions';
import ConfirmDialog from './ConfirmDialog.vue';

/**
 * Moderation dialogs, rendered once per view.
 *
 * Exposes `open()` / `openAnnounceTo()` via `defineExpose`, so a view keeps its table markup clean
 * and just calls `actions.value?.open('kick', player)` from a row handler. All state and API
 * calls live in the shared composable, so the dashboard and the players view cannot drift apart
 * on something that bans people.
 */
const {
  pending,
  busy,
  busyUserid,
  kickMessage,
  banReason,
  directMessage,
  open,
  openAnnounceTo,
  cancel,
  confirm,
} = usePlayerActions();

const activeKind = computed(() => pending.value?.kind ?? null);
const player = computed(() => pending.value?.player ?? null);

// `defineExpose` wraps these with `proxyRefs`, so a parent reading
// `actions.value.busyUserid` gets the unwrapped string rather than a ref.
defineExpose({ open, openAnnounceTo, busyUserid });
</script>

<template>
  <ConfirmDialog
    :open="activeKind === 'kick'"
    :title="PLAYER_ACTION_TITLES.kick"
    tone="danger"
    confirm-label="Kick"
    :busy="busy"
    @cancel="cancel"
    @confirm="confirm"
  >
    <p>
      <strong>{{ player?.name }}</strong> will be disconnected. They can rejoin immediately — this
      is not a ban.
    </p>
    <div>
      <label class="label" for="kick-message">Message shown to them (optional)</label>
      <input
        id="kick-message"
        v-model="kickMessage"
        class="input"
        maxlength="200"
        placeholder="Please read the server rules"
      />
    </div>
  </ConfirmDialog>

  <ConfirmDialog
    :open="activeKind === 'ban'"
    :title="PLAYER_ACTION_TITLES.ban"
    tone="danger"
    confirm-label="Ban"
    :busy="busy"
    @cancel="cancel"
    @confirm="confirm"
  >
    <p>
      <strong>{{ player?.name }}</strong> will be disconnected and blocked from rejoining. Palsentry
      records the ban so you can unban them later.
    </p>
    <div>
      <label class="label" for="ban-reason">Reason (optional)</label>
      <input
        id="ban-reason"
        v-model="banReason"
        class="input"
        maxlength="500"
        placeholder="Griefing spawn"
      />
    </div>
    <p
      class="rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
    >
      userid: {{ player?.userId }}
    </p>
  </ConfirmDialog>

  <ConfirmDialog
    :open="activeKind === 'unban'"
    title="Unban this player?"
    confirm-label="Unban"
    :busy="busy"
    @cancel="cancel"
    @confirm="confirm"
  >
    <p>
      <strong>{{ player?.name }}</strong> will be allowed to rejoin the server.
    </p>
  </ConfirmDialog>

  <ConfirmDialog
    :open="activeKind === 'announceTo'"
    :title="PLAYER_ACTION_TITLES.announceTo"
    confirm-label="Send"
    :busy="busy"
    @cancel="cancel"
    @confirm="confirm"
  >
    <p class="text-xs text-slate-500 dark:text-slate-400">
      The Palworld API only broadcasts to everyone — there is no direct-message endpoint — so this
      will be visible to all players. Naming {{ player?.name }} is the closest thing to a whisper.
    </p>
    <div>
      <label class="label" for="direct-message">Message</label>
      <input id="direct-message" v-model="directMessage" class="input" maxlength="200" />
    </div>
  </ConfirmDialog>
</template>
