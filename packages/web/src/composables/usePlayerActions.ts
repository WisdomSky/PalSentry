import { ref } from 'vue';
import type { EnrichedPlayer } from '@palsentry/shared';
import { api, errorMessage } from '@/lib/api';
import { useServerStore } from '@/stores/server';
import { useUiStore } from '@/stores/ui';

export type PlayerActionKind = 'kick' | 'ban' | 'unban' | 'announceTo';

export interface PendingPlayerAction {
  kind: PlayerActionKind;
  player: EnrichedPlayer;
}

export const PLAYER_ACTION_TITLES: Record<PlayerActionKind, string> = {
  kick: 'Kick this player?',
  ban: 'Ban this player?',
  unban: 'Unban this player?',
  announceTo: 'Send a message',
};

/**
 * Shared moderation flow.
 *
 * Used by both the dashboard and the players view so the confirmation copy, the API payloads,
 * and the post-action refresh behave identically in both places. Duplicating this would mean two
 * code paths that could drift on something that bans people.
 *
 * The Palworld API's `/kick` and `/ban` both take the `userId` and an optional message; the
 * registry metadata (player name, reason) is PalSentry's own and is sent separately.
 */
export function usePlayerActions() {
  const server = useServerStore();
  const ui = useUiStore();

  const pending = ref<PendingPlayerAction | null>(null);
  const busy = ref(false);
  /** The player being actioned, so their row can show a busy state. */
  const busyUserid = ref<string | null>(null);

  const kickMessage = ref('');
  const banReason = ref('');
  const directMessage = ref('');

  function clearForms(): void {
    kickMessage.value = '';
    banReason.value = '';
    directMessage.value = '';
  }

  function open(kind: PlayerActionKind, player: EnrichedPlayer): void {
    clearForms();
    pending.value = { kind, player };
  }

  /**
   * "Announce to" is really a broadcast.
   *
   * The REST API has no whisper/direct-message endpoint, so prefilling the player's name is the
   * closest available thing — the dialog says so explicitly rather than pretending otherwise.
   */
  function openAnnounceTo(player: EnrichedPlayer): void {
    clearForms();
    pending.value = { kind: 'announceTo', player };
    directMessage.value = `${player.name}: `;
  }

  function cancel(): void {
    pending.value = null;
    clearForms();
  }

  /** Execute the pending action. Returns true when it succeeded. */
  async function confirm(): Promise<boolean> {
    const action = pending.value;
    if (action === null) return false;

    busy.value = true;
    busyUserid.value = action.player.userId;
    const userid = action.player.userId;

    try {
      if (action.kind === 'kick') {
        const message = kickMessage.value.trim();
        await api.kick({ userid, ...(message === '' ? {} : { message }) });
        ui.success(`Kicked ${action.player.name}`);
      } else if (action.kind === 'ban') {
        const reason = banReason.value.trim();
        await api.ban({
          userid,
          playerName: action.player.name,
          ...(reason === '' ? {} : { reason, message: reason }),
        });
        ui.success(`Banned ${action.player.name}`, reason === '' ? undefined : reason);
      } else if (action.kind === 'unban') {
        await api.unban({ userid });
        ui.success(`Unbanned ${action.player.name}`);
      } else {
        await api.announce({ message: directMessage.value.trim() });
        ui.success('Message broadcast');
      }

      pending.value = null;
      clearForms();
      await server.refreshNow();
      return true;
    } catch (error) {
      ui.error(
        `${action.kind === 'announceTo' ? 'Message' : action.kind} failed`,
        errorMessage(error),
      );
      return false;
    } finally {
      busy.value = false;
      busyUserid.value = null;
    }
  }

  return {
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
  };
}
